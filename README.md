# Demo
https://youtu.be/VJdt-vAZbLo

This is an unofficial extension for SillyTavern that adds multiplayer.

The way it works is as follows:
- There is an extension that the host has to install into their SillyTavern instance
- This extension communicates with a server, sending it the chat history as well as reading out any queued messages
- The server has a front-end where you can see the chat history and send messages, sent messages get queued up and area read out by the extension

This is for advanced use and requires you to expose the server to the internet, so that your friends can hop on the front-end and send messages.

# Setup
- Host the server somewhere and tell your friends to open it in their browser, this is how they will read the chat history and send messages
- You must configure the extension to point to the server's address, where it says `const targetUrl = 'http://localhost:3000/';` in `silly-tavern-mp-extension/index.js`
- Run your SillyTavern instance with the extension installed
- Have fun, it's recommended to send messages yourself via the server front-end and not from within SillyTavern, as the extension will queue-up any messages sent from the server

# How does it work?
It mimics user actions, choosing a different persona automatically for each person that sends a message. It will type the message in the box, send it and trigger an AI generation. Feel free to customize it to your liking.
