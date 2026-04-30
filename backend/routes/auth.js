const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendVerificationEmail } = require('../config/mailer');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const VERIFICATION_EXPIRES_IN = '1d';

function requireJwtSecret() {
    if (!JWT_SECRET) {
        const error = new Error('JWT_SECRET is not configured.');
        error.statusCode = 500;
        throw error;
    }
}

function createVerificationToken(user) {
    requireJwtSecret();

    return jwt.sign(
        {
            userId: user._id.toString(),
            email: user.email,
            type: 'email-verification'
        },
        JWT_SECRET,
        { expiresIn: VERIFICATION_EXPIRES_IN }
    );
}

function buildHtmlMessage(title, message, accentColor) {
    return `
        <html>
            <body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;">
                <div style="max-width:560px;margin:60px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;text-align:center;">
                    <h1 style="margin:0 0 16px;color:${accentColor};font-size:28px;">${title}</h1>
                    <p style="margin:0;color:#334155;font-size:16px;line-height:1.7;">${message}</p>
                </div>
            </body>
        </html>
    `;
}

// POST /signup
// Creates a new user, hashes the password, stores the user, and sends a verification email.
router.post('/signup', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const existingUser = await User.findOne({ email: normalizedEmail });

        if (existingUser) {
            return res.status(409).json({ message: 'User already exists with this email.' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const user = await User.create({
            email: normalizedEmail,
            password: hashedPassword
        });

        const verificationToken = createVerificationToken(user);
        await sendVerificationEmail(user.email, verificationToken);

        return res.status(201).json({
            message: 'Signup successful. Please check your email to verify your account.'
        });
    } catch (error) {
        console.error('Signup error:', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to sign up user.'
        });
    }
});

// GET /verify/:token
// Verifies the JWT token and marks the user as verified if the token is valid.
router.get('/verify/:token', async (req, res) => {
    try {
        requireJwtSecret();

        const { token } = req.params;
        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.type !== 'email-verification') {
            return res.status(400).send(buildHtmlMessage('Invalid Token', 'The verification token type is invalid.', '#dc2626'));
        }

        const user = await User.findOne({ _id: decoded.userId, email: decoded.email });
        if (!user) {
            return res.status(404).send(buildHtmlMessage('User Not Found', 'The account for this verification link no longer exists.', '#dc2626'));
        }

        if (!user.isVerified) {
            user.isVerified = true;
            await user.save();
        }

        return res.status(200).send(buildHtmlMessage('Email Verified', 'Your email has been verified successfully. You can now log in.', '#16a34a'));
    } catch (error) {
        console.error('Verification error:', error);

        if (error.name === 'TokenExpiredError') {
            return res.status(400).send(buildHtmlMessage('Link Expired', 'This verification link has expired. Please request a new verification email.', '#d97706'));
        }

        if (error.name === 'JsonWebTokenError') {
            return res.status(400).send(buildHtmlMessage('Invalid Link', 'This verification link is invalid. Please request a new verification email.', '#dc2626'));
        }

        return res.status(500).send(buildHtmlMessage('Verification Failed', 'Something went wrong while verifying your email.', '#dc2626'));
    }
});

// POST /login
// Allows login only when the email is verified and password matches.
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        if (!user.isVerified) {
            return res.status(403).json({ message: 'Please verify your email' });
        }

        return res.status(200).json({
            message: 'Login successful',
            user: {
                id: user._id,
                email: user.email,
                isVerified: user.isVerified
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: 'Failed to log in user.' });
    }
});

// POST /resend-verification
// Sends a fresh verification link when the previous token has expired or not yet been used.
router.post('/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required.' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (user.isVerified) {
            return res.status(400).json({ message: 'Email is already verified.' });
        }

        const verificationToken = createVerificationToken(user);
        await sendVerificationEmail(user.email, verificationToken);

        return res.status(200).json({
            message: 'Verification email resent successfully.'
        });
    } catch (error) {
        console.error('Resend verification error:', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Failed to resend verification email.'
        });
    }
});

module.exports = router;
