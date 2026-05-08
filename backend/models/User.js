const mongoose = require('mongoose');

// Extended user schema for email verification auth flow and dashboard data.
const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
        },
        username: {
            type: String,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },
        password: {
            type: String,
            required: true
        },
        isVerified: {
            type: Boolean,
            default: false
        },
        emailVerified: {
            type: Boolean,
            default: false
        },
        verificationToken: {
            type: String
        },
        avatar: {
            type: String,
            default: ''
        },
        role: {
            type: String,
            default: 'farmer'
        },
        phone: {
            type: String,
            default: ''
        },
        address: {
            type: String,
            default: ''
        },
        location: {
            type: String,
            default: ''
        },
        farmSize: {
            type: Number,
            default: null
        },
        preferredCrops: {
            type: String,
            default: ''
        },
        selectedCrops: {
            type: Array,
            default: []
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
