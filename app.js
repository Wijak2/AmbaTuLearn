const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(cors({
    origin: 'http://localhost:3001',
    credentials: true
}));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000, httpOnly: true }
}));

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'ambalearning'
});
db.connect((err) => {
    if (err) throw err;
    console.log('Connected to the MySQL database.');
});

const verifySession = (req, res, next) => {
    if (!req.session.user) {
        return res.status(403).send('Access Denied');
    }
    req.user = req.session.user;
    next();
};

// Abstract Class for Common Behavior
class BaseRoutes {
    constructor(app, db) {
        if (new.target === BaseRoutes) {
            throw new Error('Cannot instantiate abstract class BaseRoutes');
        }
        this.app = app;
        this.db = db;
        this.initializeRoutes();
    }

    initializeRoutes() {
        throw new Error('initializeRoutes() must be implemented by subclasses');
    }
}

class AuthRoutes extends BaseRoutes {
    initializeRoutes() {
        this.app.post('/signup', this.signup.bind(this));
        this.app.post('/login', this.login.bind(this));
        this.app.post('/logout', this.logout.bind(this));
    }

    async signup(req, res) {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).send('Username, email, and password are required.');

        try {
            const checkQuery = 'SELECT * FROM users WHERE username = ? OR email = ?';
            this.db.query(checkQuery, [username, email], async (err, results) => {
                if (err) return res.status(500).send('Error while checking existing users.');
                if (results.length > 0) return res.status(400).send('Username or Email already exists.');

                const hashedPassword = await bcrypt.hash(password, 10);
                const query = 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)';
                this.db.query(query, [username, email, hashedPassword], (err) => {
                    if (err) return res.status(500).send('Error while creating user.');
                    res.status(201).send('User created successfully.');
                });
            });
        } catch (error) {
            res.status(500).send('Server error during signup.');
        }
    }

    login(req, res) {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).send('Username and password are required.');

        const query = 'SELECT * FROM users WHERE username = ?';
        this.db.query(query, [username], async (err, results) => {
            if (err) return res.status(500).send('Error while checking user.');
            if (results.length === 0) return res.status(400).send('Invalid username or password.');

            const user = results[0];
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) return res.status(400).send('Invalid username or password.');

            req.session.user = { id: user.id, username: user.username };
            res.json({ message: 'Login successful', user: req.session.user });
        });
    }

    logout(req, res) {
        req.session.destroy((err) => {
            if (err) return res.status(500).send('Logout failed.');
            res.send('Logout successful.');
        });
    }
}

class CourseRoutes extends BaseRoutes {
    initializeRoutes() {
        this.app.post('/courses', verifySession, this.createCourse.bind(this));
        this.app.get('/courses', this.getCourses.bind(this));
        this.app.delete('/courses/:id', verifySession, this.deleteCourse.bind(this));
    }

    createCourse(req, res) {
        const { title, description, price, image_url, discount, isPremium } = req.body;
        const parsedDiscount = parseFloat(discount) || 0;
        const parsedIsPremium = isPremium === true || isPremium === 'true';

        const query = `
            INSERT INTO courses (title, description, price, image_url, discount, isPremium)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        this.db.query(query, [title, description, price, image_url, parsedDiscount, parsedIsPremium], (err) => {
            if (err) return res.status(500).send('Failed to add course.');
            res.send('Course added successfully.');
        });
    }

    getCourses(req, res) {
        const query = 'SELECT * FROM courses';
        this.db.query(query, (err, results) => {
            if (err) return res.status(500).send('Failed to fetch courses.');
            res.json(results);
        });
    }

    deleteCourse(req, res) {
        const { id } = req.params;
        const query = 'DELETE FROM courses WHERE id = ?';
        this.db.query(query, [id], (err, result) => {
            if (err) return res.status(500).send('Failed to delete course.');
            if (result.affectedRows === 0) return res.status(404).send('Course not found.');
            res.send('Course deleted successfully.');
        });
    }
}

class PurchaseRoutes extends BaseRoutes {
    initializeRoutes() {
        this.app.post('/purchase', verifySession, this.purchaseCourse.bind(this));
        this.app.get('/purchased-courses', verifySession, this.getPurchasedCourses.bind(this));
    }

    purchaseCourse(req, res) {
        const { course_id, full_name, time_frame, payment_method, ready_to_go } = req.body;
        const user_id = req.user.id;

        const query = `
            INSERT INTO purchases (user_id, course_id, full_name, time_frame, payment_method, ready_to_go)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        this.db.query(query, [user_id, course_id, full_name, time_frame, payment_method, ready_to_go], (err) => {
            if (err) return res.status(500).json({ message: 'Failed to process purchase.' });
            res.status(200).json({ message: 'Purchase successful!' });
        });
    }

    getPurchasedCourses(req, res) {
        const user_id = req.user.id;

        const query = `
            SELECT courses.id, courses.title, courses.description, courses.price, courses.image_url
            FROM courses
            JOIN purchases ON courses.id = purchases.course_id
            WHERE purchases.user_id = ?
        `;
        this.db.query(query, [user_id], (err, results) => {
            if (err) return res.status(500).send('Failed to fetch purchased courses.');
            if (results.length === 0) return res.status(404).send('No purchased courses found.');
            res.json(results);
        });
    }
}

// MainApp class must be defined after all route classes
class MainApp {
    constructor(app, db) {
        this.app = app;
        this.db = db;
        this.initializeRoutes();
    }

    initializeRoutes() {
        new AuthRoutes(this.app, this.db);      
        new CourseRoutes(this.app, this.db);    
        new PurchaseRoutes(this.app, this.db);  
    }
}

const port = 3000;
new MainApp(app, db);

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
