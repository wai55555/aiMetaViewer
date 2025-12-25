// Brave ブラウザ専用診断スクリプト
console.log('=== Brave Browser Extension Diagnostic ===');

// 1. ブラウザ情報の取得
console.log('User Agent:', navigator.userAgent);
console.log('Is Brave:', navigator.userAgent.includes('Brave'));

// 2. Chrome API の詳細チェック
console.log('Chrome object:', typeof chrome);
console.log('Chrome runtime:', typeof chrome?.runtime);
console.log('Chrome runtime ID:', chrome?.runtime?.id);
console.log('Chrome runtime lastError:', chrome?.runtime?.lastError);

// 3. Service Worker の状態チェック
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
        console.log('Service Worker registrations:', registrations.length);
        registrations.forEach((registration, index) => {
            console.log(`Registration ${index}:`, {
                scope: registration.scope,
                active: !!registration.active,
                installing: !!registration.installing,
                waiting: !!registration.waiting
            });
        });
    });
}

// 4. Extension API の可用性テスト
const apiTests = {
    'chrome.runtime': !!chrome?.runtime,
    'chrome.runtime.sendMessage': typeof chrome?.runtime?.sendMessage === 'function',
    'chrome.runtime.onMessage': !!chrome?.runtime?.onMessage,
    'chrome.storage': !!chrome?.storage,
    'chrome.storage.local': !!chrome?.storage?.local,
    'chrome.tabs': !!chrome?.tabs,
    'chrome.downloads': !!chrome?.downloads
};

console.log('API Availability:', apiTests);

// 5. メッセージ送信テスト
if (chrome?.runtime?.sendMessage) {
    console.log('Attempting to send test message...');
    chrome.runtime.sendMessage({ action: 'brave_diagnostic_test' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Message send error:', chrome.runtime.lastError);
        } else {
            console.log('Message response:', response);
        }
    });
} else {
    console.error('chrome.runtime.sendMessage not available');
}

// 6. Brave 特有の設定チェック
console.log('Document domain:', document.domain);
console.log('Location protocol:', location.protocol);
console.log('Location hostname:', location.hostname);

// 7. Content Security Policy チェック
const metaCSP = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
if (metaCSP) {
    console.log('Page CSP:', metaCSP.content);
} else {
    console.log('No CSP meta tag found');
}

console.log('=== End Diagnostic ===');