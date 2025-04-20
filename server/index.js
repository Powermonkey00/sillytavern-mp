const express = require('express');
const app = express();
let chatHistory = [];
let queuedMessages = [];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// disable Access-Control-Allow-Origin
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// serve static files from the public directory
app.use(express.static('public'));

app.post('/set-chat', (req, res) => {
    chatHistory = req.body;

    res.send('Chat history received and stored successfully');
});

app.get('/get-chat', (req, res) => {
    res.json(chatHistory);
});

app.post('/queue-message', (req, res) => {
    queuedMessages.push(req.body);
    console.log('Queued message:', req.body);

    res.send('Message queued successfully');
});

app.get('/queued-messages', (req, res) => {
    res.json(queuedMessages);
    queuedMessages = [];
});

app.listen(3000, '0.0.0.0', () => {
    console.log('Server is running on port 3000');
});