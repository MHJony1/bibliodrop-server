const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');

const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');

dotenv.config();

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const uri = process.env.MONGODB_URI;
const port = process.env.PORT ;
const app = express();



//middleware
app.use(cors());
app.use(express.json());


//jwks token api
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);



// ✅ Verify Token 
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    
    // user info attach
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role || 'user',
      name: payload.name,
    };

    next();
  } catch (error) {
    console.error('❌ JWT Error:', error.message);
    return res.status(401).json({ msg: "Unauthorized" });
  }
};

// ✅ Role-based Middleware Functions
const verifyUser = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  // All authenticated user allowed (user, librarian, admin)
  next();
};

const verifyLibrarian = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  
  const role = req.user.role?.toLowerCase();
  if (role !== 'librarian' && role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Librarian or Admin role required.'
    });
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  
  if (req.user.role?.toLowerCase() !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin role required.'
    });
  }
  next();
};




// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});



async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db('bibliodrop_db');
    const booksCollection = db.collection('books');
    const paymentCollection = db.collection('payments');
    const usersCollection = db.collection('user');
    const reviewsCollection = db.collection('reviews');
    const wishlistCollection = db.collection('wishlist');

    // books related api for all books with search, category, price, availability
    app.get('/api/books', async (req, res) => {
      try {
        const {
          search,
          category,
          minPrice,
          maxPrice,
          availability,
          sort = 'createdAt',
          order = 'desc',
          page = 1,
          limit = 12,
        } = req.query;

        const filter = {
          status: {
            $in: ['Published', 'Available', 'Checked Out', 'Pending Delivery'],
          },
        };

        // Search
        if (search) {
          filter.$or = [
            { title: { $regex: search, $options: 'i' } },
            { author: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        // Category
        if (category && category !== 'all categories') {
          filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
        }

        // Price range
        if (minPrice || maxPrice) {
          filter.price = {};
          if (minPrice) filter.price.$gte = parseFloat(minPrice);
          if (maxPrice) filter.price.$lte = parseFloat(maxPrice);
        }

        // ✅ Availability filter
        if (availability === 'available') {
          filter.status = { $in: ['Published', 'Available'] };
        } else if (availability === 'checked_out') {
          filter.status = {
            $in: ['Checked Out', 'Pending Delivery', 'Pending'],
          };
        }

        // Sort
        const sortObj = {};
        if (sort === 'price') {
          sortObj.price = order === 'desc' ? -1 : 1;
        } else if (sort === 'title') {
          sortObj.title = order === 'desc' ? -1 : 1;
        } else {
          sortObj.dateAdded = order === 'desc' ? -1 : 1;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const limitNum = parseInt(limit);

        const [books, total] = await Promise.all([
          booksCollection
            .find(filter)
            .sort(sortObj)
            .skip(skip)
            .limit(limitNum)
            .toArray(),
          booksCollection.countDocuments(filter),
        ]);

        console.log(`📚 Found ${books.length} books (${total} total)`);

        res.json({
          success: true,
          data: books,
          pagination: {
            total,
            page: parseInt(page),
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
          },
        });
      } catch (error) {
        console.error('Books API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch books',
          error: error.message,
        });
      }
    });

    // books by ID related api for single book details
    app.get('/api/books/:id', async (req, res) => {
      const id = req.params.id;

      // Validate ObjectId
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid book ID format',
        });
      }

      try {
        // Get book details
        const book = await booksCollection.findOne({ _id: new ObjectId(id) });

        if (!book) {
          return res.status(404).json({
            success: false,
            message: 'Book not found',
          });
        }

        // Get all delivered users for this book
        const deliveredOrders = await paymentCollection
          .find({
            bookId: id,
            status: 'Delivered',
          })
          .toArray();

        const deliveredBuyers = deliveredOrders.map((o) => o.customerEmail);

        //  Return book with deliveredBuyers
        res.json({
          success: true,
          data: {
            ...book,
            deliveredBuyers: deliveredBuyers || [],
          },
        });
      } catch (error) {
        console.error('❌ Book API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch book',
          error: error.message,
        });
      }
    });

    // Librarian Dashboard Related api

    // GET: Librarian Books API
    app.get('/api/librarian/books',verifyToken, verifyLibrarian, async (req, res) => {
      try {
        const { librarianEmail } = req.query;

        // Validation
        if (!librarianEmail) {
          return res.status(400).json({
            success: false,
            message: 'librarianEmail query parameter is required.',
          });
        }

        const filter = {
          librarianEmail: librarianEmail.trim().toLowerCase(),
        };

        const books = await booksCollection
          .find(filter)
          .sort({ dateAdded: -1 })
          .toArray();

        res.json({
          success: true,
          data: books,
          total: books.length,
        });
      } catch (error) {
        console.error('Librarian Books API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch librarian books.',
          error: error.message,
        });
      }
    });

    // post api for add book data in database
    app.post('/api/books', async (req, res) => {
      try {
        // Destructure incoming request body from frontend
        const {
          title,
          author,
          description,
          category,
          bookPrice,
          deliveryFee,
          coverImage,
          status,
          librarianEmail,
          librarianName,
          userId,
        } = req.body;

        // 1. Server-side validation for required fields
        if (!title || !author || !category || !coverImage) {
          return res.status(400).json({
            success: false,
            message:
              'Missing required fields: title, author, category, and cover image are mandatory.',
          });
        }

        // 2. Format the book object to match database structure exactly
        const newBook = {
          title,
          author,
          description,
          category: category ? category.toLowerCase() : '',
          price: parseFloat(bookPrice) || 0,
          deliveryFee: parseFloat(deliveryFee) || 0,
          coverImage,
          status: status || 'Pending Approval',
          librarianEmail: librarianEmail
            ? librarianEmail.trim().toLowerCase()
            : null,
          librarianName: librarianName || 'System Librarian',
          userId: userId || null,
          dateAdded: new Date(),
        };

        // 3. Insert the document using Native MongoDB Driver
        const result = await booksCollection.insertOne(newBook);

        // 4. Send success response back to frontend
        res.status(201).json({
          success: true,
          message: 'Book submitted successfully and is pending approval!',
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error('Add Book API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Internal Server Error. Could not save book data.',
          error: error.message,
        });
      }
    });

    // book update, delete actions api
    // DELETE: Book delete
    app.delete('/api/books/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid book ID.' });
        }

        const result = await booksCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: 'Book not found.' });
        }

        res.json({ success: true, message: 'Book deleted successfully.' });
      } catch (error) {
        res.status(500).json({
          success: false,
          message: 'Failed to delete book.',
          error: error.message,
        });
      }
    });

    // PATCH: Book status toggle (Published <-> Unpublished)
    app.patch('/api/books/:id/status', async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid book ID.' });
        }

        const validStatuses = ['Published', 'Unpublished'];
        if (!validStatuses.includes(status)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid status.' });
        }

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } },
        );

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: 'Book not found.' });
        }

        res.json({ success: true, message: `Book ${status} successfully.` });
      } catch (error) {
        res.status(500).json({
          success: false,
          message: 'Failed to update status.',
          error: error.message,
        });
      }
    });

    // PATCH: Book edit/update
    app.patch('/api/books/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid book ID.' });
        }

        const {
          title,
          author,
          description,
          category,
          bookPrice,
          deliveryFee,
          coverImage,
        } = req.body;

        const updatedBook = {
          ...(title && { title }),
          ...(author && { author }),
          ...(description && { description }),
          ...(category && { category: category.toLowerCase() }),
          ...(bookPrice !== undefined && { price: parseFloat(bookPrice) || 0 }),
          ...(deliveryFee !== undefined && {
            deliveryFee: parseFloat(deliveryFee) || 0,
          }),
          ...(coverImage && { coverImage }),
          updatedAt: new Date(),
        };

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedBook },
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: 'Book not found.' });
        }

        res.json({ success: true, message: 'Book updated successfully.' });
      } catch (error) {
        res.status(500).json({
          success: false,
          message: 'Failed to update book.',
          error: error.message,
        });
      }
    });

    // GET: Librarian er deliveries for payment collection
    app.get('/api/librarian/orders', verifyToken, verifyLibrarian, async (req, res) => {
      try {
        const { librarianEmail } = req.query;

        if (!librarianEmail) {
          return res.status(400).json({
            success: false,
            message: 'librarianEmail is required.',
          });
        }

        // 1. Get all books by this librarian
        const librarianBooks = await booksCollection
          .find({ librarianEmail: librarianEmail.trim().toLowerCase() })
          .project({ _id: 1, title: 1, price: 1, deliveryFee: 1 })
          .toArray();

        console.log('📚 Librarian Books found:', librarianBooks.length);

        // 2. Get book IDs
        const bookIds = librarianBooks.map((b) => b._id.toString());

        if (bookIds.length === 0) {
          return res.json({
            success: true,
            data: [],
            total: 0,
          });
        }

        // 3. Get orders for these books
        const orders = await paymentCollection
          .find({ bookId: { $in: bookIds } })
          .sort({ createdAt: -1 })
          .toArray();

        console.log('📦 Orders found:', orders.length);

        // 4. ✅ Enrich orders with book details 
        const enrichedOrders = orders.map((order) => {
          // Find the book from librarianBooks array
          const book = librarianBooks.find(
            (b) => b._id.toString() === order.bookId,
          );

          return {
            _id: order._id,
            clientName: order.customerEmail?.split('@')[0] || 'Customer',
            clientEmail: order.customerEmail || 'N/A',
            bookTitle: order.bookTitle || book?.title || 'Unknown Book',
            date: order.createdAt || new Date().toISOString(),
            status: order.status || 'Pending',
            amount: order.amountPaid || 0,
            // ✅ Book details
            price: book?.price || 0,
            deliveryFee: book?.deliveryFee || 0,
            bookId: order.bookId,
            userId: order.userId,
            paymentStatus: order.paymentStatus,
            stripeSessionId: order.stripeSessionId,
          };
        });

        console.log('✅ Enriched Orders:', enrichedOrders.length);

        res.json({
          success: true,
          data: enrichedOrders,
          total: enrichedOrders.length,
        });
      } catch (error) {
        console.error('❌ Librarian Orders API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch orders.',
          error: error.message,
        });
      }
    });

    // PATCH: Delivery status update
    app.patch('/api/orders/:orderId/status',  async (req, res) => {
      try {
        const { orderId } = req.params;
        const { status } = req.body;

        const validStatuses = ['Pending', 'Dispatched', 'Delivered'];
        if (!validStatuses.includes(status)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid status.' });
        }

        if (!ObjectId.isValid(orderId)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid order ID.' });
        }

        // ✅ 'status' field update
        const result = await paymentCollection.updateOne(
          { _id: new ObjectId(orderId) },
          { $set: { status: status, updatedAt: new Date() } },
        );

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: 'Order not found.' });
        }

        // If status is Delivered, update book status
        if (status === 'Delivered') {
          const transaction = await paymentCollection.findOne({
            _id: new ObjectId(orderId),
          });
          if (transaction?.bookId) {
            try {
              await booksCollection.updateOne(
                { _id: new ObjectId(transaction.bookId) },
                { $set: { status: 'Checked Out' } },
              );
            } catch (e) {}
          }
        }

        res.json({ success: true, message: `Status updated to ${status}.` });
      } catch (error) {
        console.error('Update Order Status Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to update status.',
          error: error.message,
        });
      }
    });

    //  Librarian Overview API
    app.get('/api/librarian/overview', verifyToken, verifyLibrarian, async (req, res) => {
      try {
        const { librarianEmail } = req.query;

        if (!librarianEmail) {
          return res.status(400).json({
            success: false,
            message: 'librarianEmail is required.',
          });
        }

        // 1. Total Books
        const totalBooks = await booksCollection.countDocuments({
          librarianEmail: librarianEmail.trim().toLowerCase(),
        });

        // 2. Get all books by this librarian
        const books = await booksCollection
          .find({ librarianEmail: librarianEmail.trim().toLowerCase() })
          .project({ _id: 1 })
          .toArray();

        const bookIds = books.map((b) => b._id.toString());

        // 3. Get all orders for these books
        const orders = await paymentCollection
          .find({ bookId: { $in: bookIds } })
          .toArray();

        // 4. Calculate Earnings (only delivered orders)
        const deliveredOrders = orders.filter(
          (order) => order.status === 'Delivered',
        );
        const totalEarnings = deliveredOrders.reduce((sum, order) => {
          return sum + (order.amountPaid || 0);
        }, 0);

        // 5. Pending Orders
        const pendingOrders = orders.filter(
          (order) => order.status === 'Pending',
        ).length;

        // 6. Total Deliveries
        const totalDeliveries = deliveredOrders.length;

        res.json({
          success: true,
          data: {
            totalBooks,
            totalEarnings,
            pendingOrders,
            totalDeliveries,
          },
        });
      } catch (error) {
        console.error('Librarian Overview API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch overview data.',
          error: error.message,
        });
      }
    });

    //  API to fetch dashboard card metrics and chart data for Admin Overview
    app.get('/api/admin/overview', verifyToken, verifyAdmin, async (req, res) => {
      try {
        // 1. Fetch total document counts for summary cards
        const totalUsers = await usersCollection.countDocuments();
        const totalBooks = await booksCollection.countDocuments();
        const totalDeliveries = await paymentCollection.countDocuments({
          paymentStatus: 'paid',
        });

        // 2. Calculate total revenue using MongoDB aggregation for performance optimization
        const revenueAggregation = await paymentCollection
          .aggregate([
            { $match: { paymentStatus: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amountPaid' } } },
          ])
          .toArray();
        const totalRevenue = revenueAggregation[0]?.total || 0;

        // 3. Aggregate book quantities grouped by category for the Pie Chart
        const categoryData = await booksCollection
          .aggregate([
            {
              $group: {
                _id: '$category',
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                categoryName: '$_id',
                count: 1,
                _id: 0,
              },
            },
          ])
          .toArray();

        // 4. Fixed 12-Month Trend Aggregation using String-to-Date Conversion
        const rawMonthlyData = await paymentCollection
          .aggregate([
            {
              $match: { paymentStatus: 'paid' },
            },
            {
              $group: {
                _id: {
                  $month: {
                    $cond: {
                      if: { $eq: [{ $type: '$createdAt' }, 'string'] },
                      then: { $dateFromString: { dateString: '$createdAt' } },
                      else: '$createdAt',
                    },
                  },
                },
                revenue: { $sum: '$amountPaid' },
                deliveries: { $sum: 1 },
              },
            },
            {
              $sort: { _id: 1 },
            },
          ])
          .toArray();

        // Mapping month indices to string format matching the Recharts frontend array structure
        const monthsLookup = [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ];

        // Generate full calendar year baseline array ensuring months with zero activity still return telemetry
        const monthlyRevenueFeed = monthsLookup.map((monthName, index) => {
          const foundMonthData = rawMonthlyData.find(
            (item) => item._id === index + 1,
          );
          return {
            month: monthName,
            revenue: foundMonthData ? foundMonthData.revenue : 0,
            deliveries: foundMonthData ? foundMonthData.deliveries : 0,
          };
        });

        // 5. Unified System Server Response
        res.json({
          success: true,
          metrics: {
            totalUsers,
            totalBooks,
            totalDeliveries,
            totalRevenue,
          },
          categoryChart: categoryData,
          monthlyRevenueFeed: monthlyRevenueFeed, // This feeds your full-year glowing area chart directly
        });
      } catch (error) {
        console.error('Admin Overview API Error:', error);
        res
          .status(500)
          .json({ success: false, message: 'Internal Server Error' });
      }
    });

    // 🎯 API to fetch all books currently marked as "Pending Approval"
    app.get('/api/admin/pending-books', async (req, res) => {
      try {
        const pendingBooks = await booksCollection
          .find({ status: 'Pending Approval' })
          .toArray();
        res.json({ success: true, data: pendingBooks });
      } catch (error) {
        console.error('Fetch Pending Books Error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 🎯 API to approve and publish a book, making it publicly available
    app.patch('/api/admin/books/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: 'Published', approvedAt: new Date() } },
        );

        res.json({
          success: true,
          message:
            'The book has been successfully approved and published platform-wide.',
        });
      } catch (error) {
        console.error('Approve Book Error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 🎯 API to permanently delete a book by admin
    app.delete('/api/admin/books/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await booksCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: 'Book not found.' });
        }

        res.json({ success: true, message: 'Book permanently deleted.' });
      } catch (error) {
        console.error('Delete Book Error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Admin dashboard api for manage users page
    // 1. GET: for all users
    app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.json({ success: true, data: users });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 2. PATCH: user role change
    app.patch('/api/admin/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: role } },
        );
        res.json({ success: true, message: 'User role updated successfully' });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 3. DELETE: user delete
    app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        await usersCollection.deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true, message: 'User deleted successfully' });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 1. Get All Books
    app.get('/api/admin/books', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const books = await booksCollection.find().toArray();
        res.json({ success: true, data: books });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 2. Toggle Book Status (Published <-> Unpublished)
    app.patch('/api/admin/books/:id/toggle', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;
        await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } },
        );
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 3. Delete Book
    app.delete('/api/admin/books/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        await booksCollection.deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 📊 TRANSACTIONS API (Admin)

    // 1. GET: All Transactions for Admin
    app.get('/api/admin/transactions', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const transactions = await paymentCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        const enrichedTransactions = await Promise.all(
          transactions.map(async (transaction) => {
            let bookTitle = transaction.bookTitle || 'Unknown Book';
            let librarianEmail = 'N/A';
            let librarianName = 'N/A';

            if (transaction.bookId) {
              try {
                const book = await booksCollection.findOne({
                  _id: new ObjectId(transaction.bookId),
                });
                if (book) {
                  bookTitle = book.title || bookTitle;
                  librarianEmail = book.librarianEmail || 'N/A';
                  librarianName = book.librarianName || 'N/A';
                }
              } catch (e) {}
            }

            return {
              _id: transaction._id,
              transactionId: `TXN-${transaction._id.toString().slice(-8)}`,
              userEmail: transaction.customerEmail || 'Unknown User',
              userName: transaction.customerEmail?.split('@')[0] || 'User',
              librarianEmail,
              librarianName,
              bookId: transaction.bookId,
              bookTitle,
              amountPaid: transaction.amountPaid || 0,
              status: transaction.status || 'Pending',
              paymentStatus: transaction.paymentStatus || 'paid',
              date: transaction.createdAt || new Date().toISOString(),
            };
          }),
        );

        res.json({
          success: true,
          data: enrichedTransactions,
          total: enrichedTransactions.length,
        });
      } catch (error) {
        console.error('Transactions API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch transactions',
          error: error.message,
        });
      }
    });

    // 2. GET: Single Transaction by ID
    app.get('/api/admin/transactions/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid transaction ID',
          });
        }

        const transaction = await paymentCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!transaction) {
          return res.status(404).json({
            success: false,
            message: 'Transaction not found',
          });
        }

        // Get book details
        let bookTitle = transaction.bookTitle || 'Unknown Book';
        let librarianEmail = 'N/A';
        let librarianName = 'N/A';

        if (transaction.bookId) {
          try {
            const book = await booksCollection.findOne({
              _id: new ObjectId(transaction.bookId),
            });
            if (book) {
              bookTitle = book.title || bookTitle;
              librarianEmail = book.librarianEmail || 'N/A';
              librarianName = book.librarianName || 'N/A';
            }
          } catch (e) {}
        }

        res.json({
          success: true,
          data: {
            ...transaction,
            bookTitle,
            librarianEmail,
            librarianName,
            status:
              transaction.status || transaction.deliveryStatus || 'Pending',
          },
        });
      } catch (error) {
        console.error('Transaction API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch transaction',
          error: error.message,
        });
      }
    });

    // 3. PATCH: Update Transaction Delivery Status
    app.patch('/api/admin/transactions/:id/status', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid transaction ID',
          });
        }

        const validStatuses = [
          'Pending',
          'Dispatched',
          'Delivered',
          'Cancelled',
        ];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid status.',
          });
        }

        const result = await paymentCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: status, updatedAt: new Date() } },
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Transaction not found',
          });
        }

        if (status === 'Delivered') {
          const transaction = await paymentCollection.findOne({
            _id: new ObjectId(id),
          });
          if (transaction?.bookId && ObjectId.isValid(transaction.bookId)) {
            await booksCollection.updateOne(
              { _id: new ObjectId(transaction.bookId) },
              { $set: { status: 'Checked Out' } },
            );
          }
        }

        res.json({
          success: true,
          message: `Transaction status updated to ${status}`,
        });
      } catch (error) {
        console.error('Update Transaction Status Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to update transaction status',
          error: error.message,
        });
      }
    });

    // 👤 USER DASHBOARD API

    // 1. GET: User Overview Stats
    app.get('/api/user/overview', verifyToken, verifyUser,  async (req, res) => {
      try {
        const { userEmail } = req.query;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: 'userEmail is required.',
          });
        }

        // 1. Get all payments/orders by this user
        const orders = await paymentCollection
          .find({ customerEmail: userEmail.trim().toLowerCase() })
          .toArray();

        // 2. Calculate stats
        const totalBooksRead = orders.filter(
          (o) => o.status === 'Delivered',
        ).length;
        const pendingDeliveries = orders.filter(
          (o) => o.status === 'Pending' || o.status === 'Dispatched',
        ).length;
        const totalSpent = orders
          .filter(
            (o) =>
              o.status === 'Delivered' ||
              o.status === 'Pending' ||
              o.status === 'Dispatched',
          )
          .reduce((sum, o) => sum + (o.amountPaid || 0), 0);

        // 3. Monthly activity data (last 6 months)
        const monthlyData = [];
        const months = [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ];
        const currentMonth = new Date().getMonth();

        for (let i = 5; i >= 0; i--) {
          const monthIndex = (currentMonth - i + 12) % 12;
          const monthOrders = orders.filter((o) => {
            const date = new Date(o.createdAt);
            return (
              date.getMonth() === monthIndex &&
              date.getFullYear() === new Date().getFullYear()
            );
          });

          monthlyData.push({
            month: months[monthIndex],
            books: monthOrders.length,
            spent: monthOrders.reduce((sum, o) => sum + (o.amountPaid || 0), 0),
          });
        }

        res.json({
          success: true,
          data: {
            totalBooksRead,
            pendingDeliveries,
            totalSpent,
            monthlyData,
            orders: orders || [],
          },
        });
      } catch (error) {
        console.error('User Overview API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch user overview',
          error: error.message,
        });
      }
    });

    // 2. 👤 USER DELIVERY HISTORY API
    app.get('/api/user/deliveries', verifyToken, verifyUser,  async (req, res) => {
      try {
        const { userEmail } = req.query;

        console.log('🔍 ===== USER DELIVERY API CALLED =====');
        console.log('📧 User Email:', userEmail);

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: 'userEmail is required.',
          });
        }

        // ✅ Find orders
        const orders = await paymentCollection
          .find({ customerEmail: userEmail.trim().toLowerCase() })
          .sort({ createdAt: -1 })
          .toArray();

        console.log('📦 Orders Found:', orders.length);

        if (orders.length === 0) {
          return res.json({
            success: true,
            data: [],
            total: 0,
          });
        }

        // ✅ Log first order
        console.log(
          '📋 Sample Order:',
          JSON.stringify(
            {
              _id: orders[0]._id,
              bookTitle: orders[0].bookTitle,
              amountPaid: orders[0].amountPaid,
              status: orders[0].status,
              bookId: orders[0].bookId,
            },
            null,
            2,
          ),
        );

        // ✅ Enrich orders
        const enrichedDeliveries = orders.map((order) => ({
          _id: order._id,
          transactionId: `TXN-${order._id.toString().slice(-8).toUpperCase()}`,
          bookTitle: order.bookTitle || 'Unknown Book',
          coverImage: null,
          author: 'Unknown',
          totalFee: order.amountPaid || 0,
          amountPaid: order.amountPaid || 0,
          status: order.status || 'Pending',
          date: order.createdAt || new Date().toISOString(),
          bookId: order.bookId || null,
          customerEmail: order.customerEmail,
          paymentStatus: order.paymentStatus,
        }));

        console.log('✅ Enriched Count:', enrichedDeliveries.length);
        console.log(
          '✅ Sample Enriched:',
          JSON.stringify(
            {
              bookTitle: enrichedDeliveries[0]?.bookTitle,
              totalFee: enrichedDeliveries[0]?.totalFee,
              amountPaid: enrichedDeliveries[0]?.amountPaid,
              status: enrichedDeliveries[0]?.status,
            },
            null,
            2,
          ),
        );

        res.json({
          success: true,
          data: enrichedDeliveries,
          total: enrichedDeliveries.length,
        });
      } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch delivery history',
          error: error.message,
        });
      }
    });

    // GET /api/user/reading-list
    app.get('/api/user/reading-list', verifyToken, verifyUser,   async (req, res) => {
      try {
        const { userEmail } = req.query;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: 'userEmail is required.',
          });
        }

        // ✅ Get all delivered orders by this user
        const deliveredOrders = await paymentCollection
          .find({
            customerEmail: userEmail.trim().toLowerCase(),
            status: 'Delivered',
          })
          .sort({ createdAt: -1 })
          .toArray();

        // ✅ Enrich with book details
        const readingList = await Promise.all(
          deliveredOrders.map(async (order) => {
            let bookTitle = order.bookTitle || 'Unknown Book';
            let coverImage = null;
            let author = 'Unknown';
            let bookPrice = 0;
            let category = 'Uncategorized';
            let bookId = order.bookId;
            let dateRead = order.updatedAt || order.createdAt;

            if (order.bookId) {
              try {
                const book = await booksCollection.findOne({
                  _id: new ObjectId(order.bookId),
                });
                if (book) {
                  bookTitle = book.title || bookTitle;
                  coverImage = book.coverImage || null;
                  author = book.author || author;
                  bookPrice = book.price || 0;
                  category = book.category || category;
                  bookId = order.bookId;
                }
              } catch (e) {}
            }

            return {
              _id: order._id,
              bookId,
              bookTitle,
              coverImage,
              author,
              bookPrice,
              category,
              dateRead: dateRead || new Date().toISOString(),
              orderDate: order.createdAt,
              amountPaid: order.amountPaid || 0,
            };
          }),
        );

        res.json({
          success: true,
          data: readingList,
          total: readingList.length,
        });
      } catch (error) {
        console.error('Reading List API Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch reading list',
          error: error.message,
        });
      }
    });

    //user order cancel and delete actions api
    app.delete('/api/user/orders/:orderId', verifyToken, verifyUser,   async (req, res) => {
      try {
        const { orderId } = req.params;

        if (!ObjectId.isValid(orderId)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid order ID.' });
        }

        // Order
        const order = await paymentCollection.findOne({
          _id: new ObjectId(orderId),
        });

        if (!order) {
          return res
            .status(404)
            .json({ success: false, message: 'Order not found.' });
        }

        // Order delete
        await paymentCollection.deleteOne({ _id: new ObjectId(orderId) });

        // Book status
        if (order.bookId && ObjectId.isValid(order.bookId)) {
          await booksCollection.updateOne(
            { _id: new ObjectId(order.bookId) },
            { $set: { status: 'Published' } },
          );
        }

        res.json({ success: true, message: 'Order deleted successfully.' });
      } catch (error) {
        console.error('Delete Order Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to delete order.',
          error: error.message,
        });
      }
    });

    // PATCH: User order cancel
    app.patch('/api/user/orders/:orderId/cancel',  verifyToken, verifyUser,   async (req, res) => {
      try {
        const { orderId } = req.params;

        if (!ObjectId.isValid(orderId)) {
          return res
            .status(400)
            .json({ success: false, message: 'Invalid order ID.' });
        }

        // Order
        const order = await paymentCollection.findOne({
          _id: new ObjectId(orderId),
        });

        if (!order) {
          return res
            .status(404)
            .json({ success: false, message: 'Order not found.' });
        }

        //  Pending order cancel
        if (order.status !== 'Pending') {
          return res.status(400).json({
            success: false,
            message: 'Only pending orders can be cancelled.',
          });
        }

        // Status Cancelled
        await paymentCollection.updateOne(
          { _id: new ObjectId(orderId) },
          { $set: { status: 'Cancelled', updatedAt: new Date() } },
        );

        // Book status published
        if (order.bookId && ObjectId.isValid(order.bookId)) {
          await booksCollection.updateOne(
            { _id: new ObjectId(order.bookId) },
            { $set: { status: 'Published' } },
          );
        }

        res.json({ success: true, message: 'Order cancelled successfully.' });
      } catch (error) {
        console.error('Cancel Order Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to cancel order.',
          error: error.message,
        });
      }
    });

    //  REVIEWS API
    // 1. GET: All reviews for a book
    app.get('/api/books/:bookId/reviews',  async (req, res) => {
      try {
        const { bookId } = req.params;

        if (!ObjectId.isValid(bookId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid book ID',
          });
        }

        const reviews = await reviewsCollection
          .find({ bookId })
          .sort({ createdAt: -1 })
          .toArray();

        // Get average rating
        const avgRating =
          reviews.length > 0
            ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
            : 0;

        res.json({
          success: true,
          data: reviews,
          averageRating: avgRating,
          totalReviews: reviews.length,
        });
      } catch (error) {
        console.error('Get Reviews Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch reviews',
          error: error.message,
        });
      }
    });

    // 2. POST: Add a review (user can only review if delivered)
    app.post('/api/books/:bookId/reviews',  verifyToken, verifyUser,   async (req, res) => {
      try {
        const { bookId } = req.params;
        const { userId, userEmail, userName, rating, comment } = req.body;

        //  Validation
        if (!userId || !userEmail) {
          return res.status(401).json({
            success: false,
            message: 'Please login to review',
          });
        }

        if (!rating || rating < 1 || rating > 5) {
          return res.status(400).json({
            success: false,
            message: 'Rating must be between 1 and 5',
          });
        }

        if (!comment || comment.trim().length < 3) {
          return res.status(400).json({
            success: false,
            message: 'Comment must be at least 3 characters',
          });
        }

        if (!ObjectId.isValid(bookId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid book ID',
          });
        }

        //  Check if user has delivered this book
        const order = await paymentCollection.findOne({
          bookId: bookId,
          customerEmail: userEmail,
          status: 'Delivered',
        });

        if (!order) {
          return res.status(403).json({
            success: false,
            message: 'You can only review books you have received',
          });
        }

        //  Check if user already reviewed this book
        const existingReview = await reviewsCollection.findOne({
          bookId,
          userEmail,
        });

        if (existingReview) {
          return res.status(400).json({
            success: false,
            message: 'You have already reviewed this book',
          });
        }

        //  Get book details
        const book = await booksCollection.findOne({
          _id: new ObjectId(bookId),
        });

        //  Create review
        const newReview = {
          bookId,
          bookTitle: book?.title || 'Unknown Book',
          bookCover: book?.coverImage || null,
          userId,
          userEmail,
          userName: userName || userEmail.split('@')[0],
          rating: parseInt(rating),
          comment: comment.trim(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await reviewsCollection.insertOne(newReview);

        res.status(201).json({
          success: true,
          message: 'Review added successfully!',
          data: { ...newReview, _id: result.insertedId },
        });
      } catch (error) {
        console.error('Add Review Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to add review',
          error: error.message,
        });
      }
    });

    // 3. PATCH: Update a review
    app.patch('/api/reviews/:reviewId',  verifyToken, verifyUser,  async (req, res) => {
      try {
        const { reviewId } = req.params;
        const { rating, comment, userEmail } = req.body;

        if (!ObjectId.isValid(reviewId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid review ID',
          });
        }

        //  Check if review exists and belongs to user
        const review = await reviewsCollection.findOne({
          _id: new ObjectId(reviewId),
        });

        if (!review) {
          return res.status(404).json({
            success: false,
            message: 'Review not found',
          });
        }

        if (review.userEmail !== userEmail) {
          return res.status(403).json({
            success: false,
            message: 'You can only edit your own reviews',
          });
        }

        //  Update review
        const updateData = {};
        if (rating) updateData.rating = parseInt(rating);
        if (comment) updateData.comment = comment.trim();
        updateData.updatedAt = new Date().toISOString();

        await reviewsCollection.updateOne(
          { _id: new ObjectId(reviewId) },
          { $set: updateData },
        );

        res.json({
          success: true,
          message: 'Review updated successfully!',
        });
      } catch (error) {
        console.error('Update Review Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to update review',
          error: error.message,
        });
      }
    });

    // 4. DELETE: Delete a review
    app.delete('/api/reviews/:reviewId',  verifyToken, verifyUser,  async (req, res) => {
      try {
        const { reviewId } = req.params;
        const { userEmail } = req.body;

        if (!ObjectId.isValid(reviewId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid review ID',
          });
        }

        //  Check if review exists and belongs to user
        const review = await reviewsCollection.findOne({
          _id: new ObjectId(reviewId),
        });

        if (!review) {
          return res.status(404).json({
            success: false,
            message: 'Review not found',
          });
        }

        if (review.userEmail !== userEmail) {
          return res.status(403).json({
            success: false,
            message: 'You can only delete your own reviews',
          });
        }

        await reviewsCollection.deleteOne({
          _id: new ObjectId(reviewId),
        });

        res.json({
          success: true,
          message: 'Review deleted successfully!',
        });
      } catch (error) {
        console.error('Delete Review Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to delete review',
          error: error.message,
        });
      }
    });

    // 5. GET: User's all reviews
    app.get('/api/user/reviews', async (req, res) => {
      try {
        const { userEmail } = req.query;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: 'userEmail is required',
          });
        }

        const reviews = await reviewsCollection
          .find({ userEmail: userEmail.trim().toLowerCase() })
          .sort({ createdAt: -1 })
          .toArray();

        res.json({
          success: true,
          data: reviews,
          total: reviews.length,
        });
      } catch (error) {
        console.error('Get User Reviews Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch reviews',
          error: error.message,
        });
      }
    });

    //  WISHLIST API
    // 1. GET: User's wishlist
    app.get('/api/user/wishlist',  async (req, res) => {
      try {
        const { userEmail } = req.query;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: 'userEmail is required',
          });
        }

        const wishlist = await wishlistCollection
          .find({ userEmail: userEmail.trim().toLowerCase() })
          .sort({ createdAt: -1 })
          .toArray();

        // Enrich with book details
        const enrichedWishlist = await Promise.all(
          wishlist.map(async (item) => {
            let book = null;
            if (item.bookId) {
              try {
                book = await booksCollection.findOne({
                  _id: new ObjectId(item.bookId),
                });
              } catch (e) {}
            }

            return {
              _id: item._id,
              bookId: item.bookId,
              book: book || {
                title: item.bookTitle || 'Unknown Book',
                author: 'Unknown',
                price: 0,
                deliveryFee: 0,
                coverImage: null,
                category: 'General',
                status: 'Unknown',
              },
              addedAt: item.createdAt || new Date().toISOString(),
            };
          }),
        );

        res.json({
          success: true,
          data: enrichedWishlist,
          total: enrichedWishlist.length,
        });
      } catch (error) {
        console.error('Get Wishlist Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch wishlist',
          error: error.message,
        });
      }
    });

    // 2. POST: Add to wishlist
    app.post('/api/user/wishlist',  verifyToken, verifyUser,  async (req, res) => {
      try {
        const { userEmail, userId, bookId, bookTitle } = req.body;

        if (!userEmail || !bookId) {
          return res.status(400).json({
            success: false,
            message: 'userEmail and bookId are required',
          });
        }

        // Check if already in wishlist
        const existing = await wishlistCollection.findOne({
          userEmail: userEmail.trim().toLowerCase(),
          bookId: bookId,
        });

        if (existing) {
          return res.status(400).json({
            success: false,
            message: 'Book already in wishlist',
          });
        }

        // Get book details
        const book = await booksCollection.findOne({
          _id: new ObjectId(bookId),
        });

        const wishlistItem = {
          userId: userId || null,
          userEmail: userEmail.trim().toLowerCase(),
          bookId: bookId,
          bookTitle: book?.title || bookTitle || 'Unknown Book',
          bookCover: book?.coverImage || null,
          createdAt: new Date().toISOString(),
        };

        await wishlistCollection.insertOne(wishlistItem);

        res.json({
          success: true,
          message: 'Book added to wishlist!',
        });
      } catch (error) {
        console.error('Add Wishlist Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to add to wishlist',
          error: error.message,
        });
      }
    });

    // 3. DELETE: Remove from wishlist
    app.delete('/api/user/wishlist/:bookId',  verifyToken, verifyUser,  async (req, res) => {
      try {
        const { bookId } = req.params;
        const { userEmail } = req.body;

        if (!userEmail || !bookId) {
          return res.status(400).json({
            success: false,
            message: 'userEmail and bookId are required',
          });
        }

        const result = await wishlistCollection.deleteOne({
          userEmail: userEmail.trim().toLowerCase(),
          bookId: bookId,
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Book not found in wishlist',
          });
        }

        res.json({
          success: true,
          message: 'Book removed from wishlist!',
        });
      } catch (error) {
        console.error('Remove Wishlist Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to remove from wishlist',
          error: error.message,
        });
      }
    });

    // 4. CHECK: Check if book is in wishlist
    app.get('/api/user/wishlist/check',  async (req, res) => {
      try {
        const { userEmail, bookId } = req.query;

        if (!userEmail || !bookId) {
          return res.status(400).json({
            success: false,
            message: 'userEmail and bookId are required',
          });
        }

        const exists = await wishlistCollection.findOne({
          userEmail: userEmail.trim().toLowerCase(),
          bookId: bookId,
        });

        res.json({
          success: true,
          inWishlist: !!exists,
        });
      } catch (error) {
        console.error('Check Wishlist Error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to check wishlist',
          error: error.message,
        });
      }
    });

    // stripe payment related api
    app.post('/api/payment-success', async (req, res) => {
      try {
        const { sessionId } = req.body;

        if (!sessionId) {
          return res.status(400).json({ error: 'Session ID is required' });
        }
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
          const existingPayment = await paymentCollection.findOne({
            stripeSessionId: sessionId,
          });

          if (!existingPayment) {
            const paymentRecord = {
              userId: session.metadata.userId,
              bookId: session.metadata.bookId,
              bookTitle: session.metadata.bookTitle,
              customerEmail: session.customer_details.email,
              amountPaid: session.amount_total / 100,
              stripeSessionId: sessionId,
              paymentStatus: 'paid',
              status: 'Pending',
              createdAt: new Date().toISOString(),
            };

            const result = await paymentCollection.insertOne(paymentRecord);

            if (session.metadata?.bookId) {
              await booksCollection.updateOne(
                { _id: new ObjectId(session.metadata.bookId) },
                { $set: { status: 'Checked Out' } },
              );
            }
            return res
              .status(200)
              .json({ success: true, message: 'Saved to MongoDB!', result });
          }

          return res
            .status(200)
            .json({ success: true, message: 'Already logged.' });
        }

        return res
          .status(400)
          .json({ error: 'Stripe transaction not completed' });
      } catch (error) {
        console.error('Server DB Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!',
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('This is Bibliodrop Server');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
