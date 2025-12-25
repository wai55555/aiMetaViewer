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
  - **Civitai**: Detects model files (.safetensors, .ckpt) and sample images with optimized API URL handling.
  - **Local Files**: Supports images opened via `file://` URLs.
- **Supported Formats**:
  - PNG (tEXt / iTXt / Stealth Info)
  - JPEG (Exif UserComment)
  - WebP (EXIF Chunk)
  - AVIF (Exif UserComment)
  - Safetensors (Model metadata)
- **Supported Generators**:
  - Stable Diffusion WebUI (A1111, Forge)
  - ComfyUI (Workflow JSON supported)
  - NovelAI (V3 / V4 / V4.5)
  - Tensor.art
- **Detailed Viewer**:
  - Automatically categorizes into Positive / Negative Prompt / Other Settings.
  - **Multi-color Highlighting**: Color-coded parameters for easier reading (Model, ADetailer, Hires, Lora).
  - Copy all metadata with one click.
  - Formatted JSON view.
- **Action-Triggered Downloader**:
  - Click the extension icon to scan the entire page.
  - Bulk download detected images, videos, audio, and archives.
  - **Flexible Folder Naming**: Automatically organize downloads by Page Title, Domain, or Flat structure.
  - **Smart Filtering**: Filter by media type (Images, Videos, Audio, Archives) or AI-generated content.
  - **Media Type Support**: Download images, videos, audio files, and model archives (.safetensors, .ckpt, .zip, etc.).
- **Cross-Browser Support**:
  - Chrome/Chromium-based browsers (Chrome, Brave, Edge, etc.)
  - Robust extension context validation with automatic recovery.

## ⚙️ Settings

Right-click the extension icon -> "Options" to configure:

- **Image Processing**: Set minimum pixel count threshold for metadata check.
- **Excluded Sites**: Disable extension on specific sites using wildcards (e.g., `civitai.com*`).
- **Downloader Configuration**: 
  - Choose your preferred folder organization (Page Title, Domain, or None).
  - Customize the main folder name (default: `AI_Meta_Viewer`).
  - Option to save directly to the Downloads root.
- **Notifications**: Toggle error notifications.
- **Cache**: Clear metadata cache to free up memory.

## 🚀 Installation

[Chrome Web Store](https://chromewebstore.google.com/detail/ai-meta-viewer/glggkpjfgbabooefiijgnaemfabdmkgf?hl=en&authuser=5)
latest version is avaiable on Chrome Web Store.

~~Please manually install the latest version using the following steps.~~

![](https://raw.githubusercontent.com/wai55555/aiMetaViewer/refs/heads/main/sample/code_download_zip.png)

~~1. Download this repository (Click **Code** -> **Download ZIP**).~~
~~2. Unzip the downloaded file.~~
~~3. Open Google Chrome and navigate to `chrome://extensions`.~~
~~4. Enable **"Developer mode"** in the top right corner.~~
~~5. Click **"Load unpacked"**.~~
~~6. Select the `extension` folder inside the unzipped directory.~~

## 📖 Usage

### Individual Image View
1. Open a website containing AI-generated images with the extension enabled.
2. A **"View Metadata"** badge will appear on the top-left of detected images.
3. Click the badge to open a modal window with detailed metadata.
4. Use the "Copy" buttons to copy content to your clipboard.

### Full-Page Scan & Bulk Download
1. Click the **AI Meta Viewer** extension icon in your toolbar.
2. A scanning overlay will show progress as it discovers images.
3. Once complete, a downloader modal will appear.
4. Filter or select the images you want to save.
5. Click **"Download Selected"**. Images will be saved to your browser's download folder, organized by your chosen folder mode.

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
└─ extension/              # Source code
   ├── manifest.json       # Manifest file (Manifest V3)
   ├── background.js       # Service Worker (Downloads, parsing, metadata extraction)
   ├── content.js          # Content Script (Badge management, page observation)
   ├── scanner.js          # Full-page scan & downloader UI
   ├── parser.js           # Binary metadata parser (PNG, JPEG, WebP, AVIF, Safetensors)
   ├── adapters.js         # Site-specific adapters (Discord, Pixiv, Civitai, etc.)
   ├── ui.js               # UI components (Modals, badges)
   ├── badge_controller.js # Badge lifecycle management
   ├── settings_loader.js  # Settings management
   ├── options.html        # Options page
   ├── options.js          # Options logic
   ├── styles.css          # Global styles
   ├── scanner/            # Scanner utilities
   │  ├── utils.js         # Helper functions (media type detection, file size formatting)
   │  ├── progress-ui.js   # Progress overlay UI
   │  └── thumbnail-finder.js # Thumbnail detection for videos/links
   └── icons/              # Extension icons
```

## 📜 License

MIT License

## 🔐 Privacy Policy

This extension does not collect any user data. All processing is done locally.

Details: [Privacy Policy](https://wai55555.github.io/aiMetaViewer/privacy-policy.html)
