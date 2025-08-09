// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);

let lastChatHistoryString = '';
function handleIncomingMessage() {
  // no longer needed as we send every 2 seconds, so this was commented:
  // sendChatHistory();
}

setInterval(() => {
  sendChatHistory();
  getQueuedMessages();
}, 2 * 1000);

const targetUrl = 'http://localhost:3000/';

function sendChatHistory() {
  if (lastChatHistoryString === JSON.stringify(getContext().chat)) {
    console.log('No changes in chat history, not sending.');
    return;
  }

  lastChatHistoryString = JSON.stringify(getContext().chat);

  console.log('Sending chat history...');

  const url = targetUrl + 'set-chat';

  const chatHistory = getContext().chat;

  // POST this data to url
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(chatHistory),
  }).then(response => {
    if (response.ok) {
      console.log('Chat history sent successfully');
    } else {
      console.error('Error sending chat history:', response.statusText);
    }
  }).catch(error => {
    console.error('Error:', error);
  });
}

function getQueuedMessages() {
  // do a fetch for /queued-messages
  const url = targetUrl + 'queued-messages';

  fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    },
  }).then(response => {
    if (response.ok) {
      return response.json();
    } else {
      console.error('Error fetching queued messages:', response.statusText);
    }
  }).then(data => {
    // queue up each message with 10 seconds between each message
    const messages = data;
    let delay = 0;
    messages.forEach(message => {
      setTimeout(() => {
        sendMessageAs(message.name, message.message);
      }, delay);
      delay += 10000; // 10 seconds
    });    
  }).catch(error => {
    console.error('Error:', error);
  });
}

function getSelectedAvatarText() {
  const sel = $('#user_avatar_block .avatar-container.selected');
  return (sel.text() || '').trim();
}

function clickAvatarByName(name) {
  if (!name) return false;
  let found = false;
  const target = name.trim().toLowerCase();
  $("#user_avatar_block .avatar-container").each((_, v) => {
    const label = ($(v).text() || '').trim().toLowerCase();
    if (label === target || label.includes(target)) { $(v).click(); found = true; return false; }
  });
  return found;
}

function sendMessageAs(name, message) {
  console.log('Sending (snap‑back):', name, message);

  const previous = getSelectedAvatarText();
  const switched = name && clickAvatarByName(name);

  // put text in box and fire input so ST’s handlers run
  $("#send_textarea").val(message).trigger('input');

  // actually SEND (this appends the user message)
  const $send = $("#send_but");
  if ($send.length) {
    $send.trigger('click');
  } else {
    // fallback for older builds
    const e = $.Event('keydown', { key: 'Enter', which: 13 });
    $("#send_textarea").trigger(e);
  }

  // snap persona back after ST queues the send
  setTimeout(() => {
    if (previous && previous.toLowerCase() !== (name || '').toLowerCase()) {
      clickAvatarByName(previous);
    }
  }, 400);
}
