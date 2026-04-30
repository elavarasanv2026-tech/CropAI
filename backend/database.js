const fs = require('fs');
const path = require('path');

class Database {
    constructor(filename = 'farmers.json') {
        this.filename = path.join(__dirname, filename);
        this.data = this.loadData();
    }

    loadData() {
        try {
            if (fs.existsSync(this.filename)) {
                const fileContent = fs.readFileSync(this.filename, 'utf8');
                const data = JSON.parse(fileContent);
                if (!data || !Array.isArray(data.users)) {
                    return { users: [] };
                }
                return data;
            }
        } catch (error) {
            console.error('Error loading database:', error);
        }
        return { users: [] };
    }

    saveData() {
        try {
            fs.writeFileSync(this.filename, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error('Error saving database:', error);
            throw error;
        }
    }

    // User operations
    createUser(userData) {
        const user = {
            id: Date.now(),
            ...userData,
            createdAt: new Date().toISOString()
        };
        this.data.users.push(user);
        this.saveData();
        return user;
    }

    findUserByEmail(email) {
        if (!email) return null;
        return this.data.users.find(user => String(user.email).toLowerCase() === String(email).toLowerCase());
    }

    findUserByUsername(username) {
        if (!username) return null;
        return this.data.users.find(user => String(user.username).toLowerCase() === String(username).toLowerCase());
    }

    findUserById(id) {
        if (!id) return null;
        // String conversion handles number-string mismatch (very common with session storage)
        return this.data.users.find(user => String(user.id) === String(id));
    }

    findUserByEmailOrUsername(email, username) {
        return this.data.users.find(user => 
            (email && String(user.email).toLowerCase() === String(email).toLowerCase()) || 
            (username && String(user.username).toLowerCase() === String(username).toLowerCase())
        );
    }

    updateUser(id, updates) {
        if (!id) return null;
        const index = this.data.users.findIndex(user => String(user.id) === String(id));
        if (index !== -1) {
            const { id: _, createdAt: __, ...safeUpdates } = updates;
            this.data.users[index] = { ...this.data.users[index], ...safeUpdates };
            this.saveData();
            return this.data.users[index];
        }
        return null;
    }
}

module.exports = Database;
