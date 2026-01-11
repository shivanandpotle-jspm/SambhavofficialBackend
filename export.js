const fs = require('fs');
const path = require('path');
const { getDb, connectToDatabase } = require('./database');

async function exportTicketsToCSV() {
    try {
        await connectToDatabase();
        const db = getDb();
        
        // 1. Fetch all tickets from MongoDB
        const tickets = await db.collection('tickets').find({}).toArray();
        console.log(`🔎 Found ${tickets.length} tickets to export.`);

        if (tickets.length === 0) {
            console.log('No tickets to export.');
            return;
        }

        // 2. Define CSV headers
        const headers = Object.keys(tickets[0]);
        
        // 3. Convert data to CSV format
        const csvRows = [
            headers.join(','), 
            ...tickets.map(row => 
                headers.map(fieldName => {
                    let fieldValue = row[fieldName];
                    if (fieldValue === null || fieldValue === undefined) return '';
                    let stringValue = String(fieldValue);
                    if (stringValue.includes(',') || stringValue.includes('"')) {
                        return `"${stringValue.replace(/"/g, '""')}"`;
                    }
                    return stringValue;
                }).join(',')
            )
        ];

        // 4. Write to file
        fs.writeFileSync('tickets_export.csv', csvRows.join('\n'));
        console.log('✅ Export successful! Data saved to tickets_export.csv');
    } catch (error) {
        console.error('❌ Export failed:', error);
    }
}

exportTicketsToCSV();
