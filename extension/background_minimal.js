// Minimal background.js for testing
console.log('Minimal background service worker loaded');

// Test basic Chrome APIs
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Message received:', request);
    sendResponse({ success: true });
});

console.log('Background service worker setup complete');