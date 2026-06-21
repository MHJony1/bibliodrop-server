const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');

// const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
dotenv.config();

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const uri = process.env.MONGODB_URI;
const port = process.env.PORT || 5000;
const app = express();

//middleware
app.use(cors());
app.use(express.json());

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

//jwks token api
// const jwks = createRemoteJWKSet(
//   new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
// );

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db('bibliodrop_db');
    const booksCollection = db.collection('books');
    const paymentCollection = db.collection('payments');
    const usersCollection = db.collection('user');

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
          status: 'Published',
        };

        // Search
        if (search) {
          filter.$or = [
            { title: { $regex: search, $options: 'i' } },
            { author: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        // ✅ Category — case-insensitive regex (DB: "romance", "sci-fi", "academic"...)
        if (category && category !== 'all categories') {
          filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
        }

        // ✅ Price range — DB field is "price" (not deliveryFee)
        if (minPrice || maxPrice) {
          filter.price = {};
          if (minPrice) filter.price.$gte = parseFloat(minPrice);
          if (maxPrice) filter.price.$lte = parseFloat(maxPrice);
        }

        // ✅ Availability — DB values: "available" | "checked_out"
        if (availability === 'available') {
          filter.status = 'Published';
        } else if (availability === 'checked_out') {
          filter.status = 'Pending Delivery';
        }

        // ✅ Sort — "price" field support added, removed wrong "deliveryFee" sort
        const sortObj = {};
        if (sort === 'price') {
          sortObj.price = order === 'desc' ? -1 : 1;
        } else if (sort === 'title') {
          sortObj.title = order === 'desc' ? -1 : 1;
        } else {
          sortObj[sort === 'createdAt' ? 'dateAdded' : sort] =
            order === 'desc' ? -1 : 1;
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
        const book = await booksCollection.findOne({ _id: new ObjectId(id) });

        if (book) {
          res.json({ success: true, data: book });
        } else {
          res.status(404).json({
            success: false,
            message: 'Book not found',
          });
        }
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
    app.get('/api/librarian/books', async (req, res) => {
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
    app.get('/api/librarian/orders', async (req, res) => {
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

        // 4. ✅ Enrich orders with book details (ঠিক করা)
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
    app.patch('/api/orders/:orderId/status', async (req, res) => {
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
                { $set: { status: 'Available' } },
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
    app.get('/api/librarian/overview', async (req, res) => {
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
    app.get('/api/admin/overview', async (req, res) => {
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
    app.patch('/api/admin/books/:id/approve', async (req, res) => {
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
    app.delete('/api/admin/books/:id', async (req, res) => {
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
    app.get('/api/admin/users', async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.json({ success: true, data: users });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 2. PATCH: user role change
    app.patch('/api/admin/users/:id/role', async (req, res) => {
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
    app.delete('/api/admin/users/:id', async (req, res) => {
      try {
        const { id } = req.params;
        await usersCollection.deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true, message: 'User deleted successfully' });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 1. Get All Books
    app.get('/api/admin/books', async (req, res) => {
      try {
        const books = await booksCollection.find().toArray();
        res.json({ success: true, data: books });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 2. Toggle Book Status (Published <-> Unpublished)
    app.patch('/api/admin/books/:id/toggle', async (req, res) => {
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
    app.delete('/api/admin/books/:id', async (req, res) => {
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
    app.get('/api/admin/transactions', async (req, res) => {
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
    app.get('/api/admin/transactions/:id', async (req, res) => {
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
    app.patch('/api/admin/transactions/:id/status', async (req, res) => {
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
              { $set: { status: 'Available' } },
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
