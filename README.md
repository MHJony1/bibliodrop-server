<div align="center">

# ⚙️ BiblioDrop — Server

### *REST API & Backend Engine for BiblioDrop*

> The server-side of **BiblioDrop** — a full-stack Online Book Delivery Management System. Built with Node.js, Express.js, and MongoDB Atlas. Handles authentication, book management, delivery tracking, Stripe payments, and admin operations.

<br/>

[![Client Repository](https://img.shields.io/badge/🖥️_Client_Repo-Visit-6C47FF?style=for-the-badge)](https://github.com/MHJony1/bibliodrop-client)
[![Live API](https://img.shields.io/badge/🌐_Live_API-Production-22C55E?style=for-the-badge)](https://bibliodrop-server.vercel.app)
[![Live Site](https://img.shields.io/badge/🚀_Live_Site-BiblioDrop-F59E0B?style=for-the-badge)](https://bibliodrop-client-nu.vercel.app)

<br/>

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-000000?style=flat-square&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB_Atlas-47A248?style=flat-square&logo=mongodb&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-000000?style=flat-square&logo=jsonwebtokens&logoColor=white)
![Stripe](https://img.shields.io/badge/Stripe-635BFF?style=flat-square&logo=stripe&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)

</div>

## 🌟 Overview

This is the **backend API** for BiblioDrop. It powers all core platform features:

- 🔐 **JWT Authentication** — Stateless auth with HTTP-only cookie-based tokens
- 📚 **Book Management** — Full CRUD with approval workflow and inventory control
- 🚚 **Delivery Tracking** — Status pipeline: `Pending → Dispatched → Delivered`
- 💳 **Stripe Integration** — Secure delivery fee payment processing
- ⭐ **Verified Reviews** — Only users with a confirmed delivery can post a review
- 👥 **Role-Based API** — Route-level protection for Reader, Librarian, and Admin
- 📊 **Admin Analytics** — Platform-wide stats, transactions, and user management

---

## 🔗 Project Links

| Resource | Link |
|---|---|
| 🌐 Live Site | [https://bibliodrop-client-nu.vercel.app](https://bibliodrop-client-nu.vercel.app) |
| 🖥️ Client Repository | [bibliodrop-client](https://github.com/MHJony1/bibliodrop-client) |
| ⚙️ Server Repository | [bibliodrop-server](https://github.com/MHJony1/bibliodrop-server) *(you are here)* |

---



### 📚 Books
| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/api/books` | Browse all books (filter, sort, paginate) | Public |
| `GET` | `/api/books/:id` | Get single book details | Public |
| `POST` | `/api/books` | Add new book → `Pending Approval` | Librarian |
| `PATCH` | `/api/books/:id` | Edit book details | Librarian |
| `PATCH` | `/api/books/:id/status` | Publish / Unpublish toggle | Librarian / Admin |
| `DELETE` | `/api/books/:id` | Delete a book | Librarian / Admin |

### 👤 Users
| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/api/users` | Get all users | Admin |
| `GET` | `/api/users/:email` | Get single user by email | Auth |
| `PATCH` | `/api/users/role` | Change user role | Admin |
| `PATCH` | `/api/users/block/:id` | Block / Unblock user | Admin |
| `DELETE` | `/api/users/:id` | Delete user | Admin |

### 🚚 Deliveries
| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/api/deliveries` | Get all deliveries | Admin / Librarian |
| `GET` | `/api/deliveries/user` | Get logged-in user's deliveries | Reader |
| `POST` | `/api/deliveries` | Create delivery request | Reader |
| `PATCH` | `/api/deliveries/:id` | Update delivery status | Librarian |

### ⭐ Reviews
| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/api/reviews/:bookId` | Get all reviews for a book | Public |
| `POST` | `/api/reviews` | Post a review (verified delivery only) | Reader |
| `PATCH` | `/api/reviews/:id` | Edit own review | Reader |
| `DELETE` | `/api/reviews/:id` | Delete own review | Reader |

### 💳 Payments
| Method | Endpoint | Description | Access |
|---|---|---|---|
| `POST` | `/api/payments` | Create Stripe payment intent | Auth |
| `GET` | `/api/payments` | Get all transactions | Admin |

---

## 🛠️ Tech Stack

| Technology | Role |
|---|---|
| **Node.js** | Server runtime environment |
| **Express.js** | REST API framework |
| **MongoDB Atlas** | Cloud database (native driver) |
| **JWT** | Stateless token-based authentication |
| **Stripe** | Payment gateway for delivery fees |
| **Vercel** | Production deployment |

---

## 📦 NPM Packages

| Package | Purpose |
|---|---|
| `express` | Node.js web framework |
| `mongodb` | MongoDB native driver |
| `jsonwebtoken` | JWT token generation & verification |
| `cors` | Cross-origin resource sharing |
| `dotenv` | Environment variable management |
| `cookie-parser` | HTTP cookie parsing middleware |
| `stripe` | Stripe server-side SDK |

---

## 📁 Folder Structure

```
bibliodrop-server/
│
├── index.js                                  # Express app — entry point
│   │
│   ├── 🔧 Middleware Setup
│   │   ├── cors()                            # Allow client origin
│   │   ├── express.json()                    # Parse JSON body
│   │   └── cookieParser()                    # Parse HTTP-only cookies
│   │
│   ├── 🔐 Auth Routes
│   │   ├── POST   /api/jwt                   # Sign & issue JWT
│   │   └── POST   /api/logout                # Clear cookie
│   │
│   ├── 📚 Books Routes
│   │   ├── GET    /api/books                 # Browse (filter + sort + paginate)
│   │   ├── GET    /api/books/:id             # Single book
│   │   ├── POST   /api/books                 # Add book → Pending Approval
│   │   ├── PATCH  /api/books/:id             # Edit book
│   │   ├── PATCH  /api/books/:id/status      # Publish / Unpublish
│   │   └── DELETE /api/books/:id             # Delete book
│   │
│   ├── 👤 Users Routes
│   │   ├── GET    /api/users                 # All users (Admin)
│   │   ├── GET    /api/users/:email          # Single user
│   │   ├── PATCH  /api/users/role            # Change role
│   │   ├── PATCH  /api/users/block/:id       # Block / Unblock
│   │   └── DELETE /api/users/:id             # Delete user
│   │
│   ├── 🚚 Deliveries Routes
│   │   ├── GET    /api/deliveries            # All deliveries
│   │   ├── GET    /api/deliveries/user       # User's own deliveries
│   │   ├── POST   /api/deliveries            # Create delivery request
│   │   └── PATCH  /api/deliveries/:id        # Update status
│   │
│   ├── ⭐ Reviews Routes
│   │   ├── GET    /api/reviews/:bookId       # Book reviews
│   │   ├── POST   /api/reviews               # Post review
│   │   ├── PATCH  /api/reviews/:id           # Edit review
│   │   └── DELETE /api/reviews/:id           # Delete review
│   │
│   └── 💳 Payments Routes
│       ├── POST   /api/payments              # Stripe payment intent
│       └── GET    /api/payments              # All transactions (Admin)
│
├── .env                                     
├── .gitignore
├── package.json
├── package-lock.json
└── vercel.json                               # Vercel deployment config
```

## 📄 License

This project is built for educational and assessment purposes.

---

<div align="center">

**⚙️ BiblioDrop Server** — Part of the BiblioDrop Full-Stack Project

🖥️ Looking for the frontend? → [bibliodrop-client](https://github.com/MHJony1/bibliodrop-client)

Made with ❤️ by **Mahmudul Hasan Jony**


</div>
