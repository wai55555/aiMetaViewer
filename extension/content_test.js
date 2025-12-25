// 最小限のテスト用 Content Script
console.log('Test Content Script loaded');
console.log('Chrome runtime available:', !!chrome?.runtime);

// Background Script との通信テスト
if (chrome?.runtime) {
    chrome.runtime.sendMessage({ action: 'test' }, (response) => {
        console.log('Background response:', response);
    });
} else {
    console.error('Chrome runtime not available');
}