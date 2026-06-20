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

        const filter = {};

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
          filter.status = 'available';
        } else if (availability === 'checked_out') {
          filter.status = 'checked_out';
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

    // payment related api for stripe checkout
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
              createdAt: new Date(),
            };

            const result = await paymentCollection.insertOne(paymentRecord);

            if (session.metadata?.bookId) {
              await booksCollection.updateOne(
                { _id: new ObjectId(session.metadata.bookId) },
                { $set: { status: 'Pending Delivery' } },
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
