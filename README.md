# AI Meta Viewer (Chrome Extension)

[🇯🇵 日本語版 (Japanese)](./README_ja.md)

![](https://raw.githubusercontent.com/wai55555/aiMetaViewer/refs/heads/main/sample/sample_civitai.png)

[Chrome Web Store](https://chromewebstore.google.com/detail/ai-meta-viewer/glggkpjfgbabooefiijgnaemfabdmkgf?hl=en&authuser=5)

A Chrome extension that allows you to easily view metadata (prompts, generation settings, etc.) of AI-generated images directly in your browser.
It automatically analyzes images on web pages and displays a badge if metadata is detected.

## ✨ Key Features

- **Auto Detection**: Automatically detects images containing AI generation metadata on web pages.
- **Stealth PNG Support**: Detects "Stealth PNG Info" hidden in the alpha channel.
- **Advanced Link Analysis**:
  - **Discord**: Automatically detects original image links from previews to retrieve full metadata.
  - **Pixiv**: Detects original image links.
  - **Local Files**: Supports images opened via `file://` URLs.
- **Supported Formats**:
  - PNG (tEXt / iTXt / Stealth Info)
  - JPEG (Exif UserComment)
  - WebP (EXIF Chunk)
  - AVIF (Exif UserComment)
- **Supported Generators**:
  - Stable Diffusion WebUI (A1111, Forge)
  - ComfyUI (Workflow JSON supported)
  - NovelAI (V3 / V4 / V4.5)
  - Tensor.art
- **Detailed Viewer**:
  - Automatically categorizes into Positive / Negative Prompt / Other Settings.
  - Copy all metadata with one click.
  - Formatted JSON view.

## ⚙️ Settings

Right-click the extension icon -> "Options" to configure:

- **Image Processing**: Set minimum pixel count threshold for metadata check.
- **Excluded Sites**: Disable extension on specific sites using wildcards (e.g., `civitai.com*`).
- **Notifications**: Toggle error notifications.
- **Cache**: Clear metadata cache to free up memory.

## 🚀 Installation

[Chrome Web Store](https://chromewebstore.google.com/detail/ai-meta-viewer/glggkpjfgbabooefiijgnaemfabdmkgf?hl=en&authuser=5)

Please manually install the latest version using the following steps.

![](https://raw.githubusercontent.com/wai55555/aiMetaViewer/refs/heads/main/sample/code_download_zip.png)

1. Download this repository (Click **Code** -> **Download ZIP**).
2. Unzip the downloaded file.
3. Open Google Chrome and navigate to `chrome://extensions`.
4. Enable **"Developer mode"** in the top right corner.
5. Click **"Load unpacked"**.
6. Select the `extension` folder inside the unzipped directory.

## 📖 Usage

1. Open a website containing AI-generated images with the extension enabled.
2. A **"View Metadata"** badge will appear on the top-left of detected images.
3. Click the badge to open a modal window with detailed metadata.
4. Use the "Copy" buttons to copy content to your clipboard.

## 🔒 Privacy & Security

- **Local Processing**: All image analysis is performed entirely within your browser (locally). No image data or metadata is sent to external servers.
- **Permissions**:
  - `activeTab` / `host_permissions`: Used to access image data on web pages.
  - `storage`: Used to save user settings locally.

## 🛠️ Technical Specs

- **Manifest V3** compliant
- **Background Service Worker**: Handles image fetching and binary parsing (including Stealth PNG optimization).
- **Content Script**: Handles DOM monitoring and UI rendering.
- **Parser**: Binary parser ported to JavaScript (supports endianness and character encoding detection).

## 📂 Directory Structure

```
aiMetaViewer/
└─ extension/          # Source code
   ├── manifest.json   # Manifest file
   ├── background.js   # Service Worker
   ├── content.js      # Content Script
   ├── parser.js       # Metadata Parser
   ├── ui.js           # UI Components
   ├── options.html    # Options Page
   ├── options.js      # Options Logic
   ├── styles.css      # Styles
   └── icons/          # Icons
```

## 📜 License

MIT License

## 🔐 Privacy Policy

This extension does not collect any user data. All processing is done locally.

Details: [Privacy Policy](https://wai55555.github.io/aiMetaViewer/privacy-policy.html)
