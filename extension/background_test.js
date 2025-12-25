// 最小限のテスト用 Service Worker
console.log('Test Service Worker: Starting...');

try {
    // 基本的な Chrome API テスト
    console.log('Test Service Worker: Chrome runtime available:', !!chrome.runtime);
    console.log('Test Service Worker: Chrome tabs available:', !!chrome.tabs);
    console.log('Test Service Worker: Chrome storage available:', !!chrome.storage);

    // メッセージリスナーのテスト
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log('Test Service Worker: Message received:', request);
        sendResponse({ success: true, message: 'Test response' });
        return true;
    });

    console.log('Test Service Worker: Successfully loaded');
} catch (error) {
    console.error('Test Service Worker: Error during initialization:', error);
}