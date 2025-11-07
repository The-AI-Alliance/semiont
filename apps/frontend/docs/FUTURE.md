# Future Frontend Implementations

**Last Updated**: 2025-10-25

Ideas and architecture considerations for building alternative frontend clients for the Semiont platform, including mobile apps, browser extensions, and specialized integrations.

## Table of Contents

- [Overview](#overview)
- [Mobile Applications](#mobile-applications)
- [Browser Extensions](#browser-extensions)
- [Desktop Applications](#desktop-applications)
- [Specialized Integrations](#specialized-integrations)
- [Shared Infrastructure](#shared-infrastructure)
- [Design Principles](#design-principles)
- [Related Documentation](#related-documentation)

## Overview

The Semiont platform is designed with frontend flexibility in mind. The backend provides a comprehensive REST API following the W3C Web Annotation Data Model, enabling diverse client implementations while maintaining full interoperability.

**Current Frontend**: Next.js 14 web application (this repo)

**Future Frontends**: Mobile apps, browser extensions, desktop apps, CLI tools, specialized integrations

**Key Enabler**: `@semiont/api-client` package provides type-safe API access for any TypeScript/JavaScript client

## Mobile Applications

### Native iOS App

**Use Cases**:
- Annotate documents on mobile devices
- Quick capture of highlights and entity tags
- Offline reading with sync
- Push notifications for collaboration

**Architecture**:
- **Language**: Swift/SwiftUI
- **API Client**: Native Swift client implementing OpenAPI spec
- **Storage**: Core Data for offline caching
- **Sync**: Background sync when online
- **Auth**: OAuth via ASWebAuthenticationSession

**Key Features**:
- Document reader with annotation overlays
- Text selection for quick highlights
- Voice-to-text for entity tagging
- Camera integration for OCR document capture
- iCloud sync for personal annotations

**Challenges**:
- Text selection in native views (complex for PDFs)
- Offline event queue with conflict resolution
- W3C annotation rendering on mobile constraints

**Starting Point**:
```swift
// Use @semiont/api-client OpenAPI spec to generate Swift client
// openapi-generator generate -i openapi.json -g swift5 -o SemiontClient

import SemiontClient

let client = SemiontClient(basePath: "https://api.semiont.ai")
client.authenticate(token: jwtToken)

// Fetch documents
client.documentsAPI.listDocuments { (documents, error) in
    // Handle documents
}
```

### Native Android App

**Use Cases**: Same as iOS

**Architecture**:
- **Language**: Kotlin + Jetpack Compose
- **API Client**: Kotlin client from OpenAPI spec
- **Storage**: Room database for offline
- **Sync**: WorkManager for background sync
- **Auth**: Chrome Custom Tabs for OAuth

**Key Features**: Similar to iOS

**Starting Point**:
```kotlin
// Generate Kotlin client from OpenAPI spec
// openapi-generator generate -i openapi.json -g kotlin -o SemiontClient

import ai.semiont.client.*

val client = SemiontClient(basePath = "https://api.semiont.ai")
client.setAccessToken(jwtToken)

// Fetch documents
val documents = client.documentsApi.listDocuments()
```

### React Native App

**Use Cases**: Cross-platform mobile with shared codebase

**Architecture**:
- **Framework**: React Native + Expo
- **API Client**: `@semiont/api-client` (reuse existing!)
- **Storage**: AsyncStorage + SQLite
- **Sync**: React Query with persistence
- **Auth**: expo-auth-session for OAuth

**Key Advantages**:
- **Reuse `@semiont/api-client`** - no new client needed
- Shared business logic with web frontend
- TypeScript throughout
- Faster development

**Starting Point**:
```typescript
// apps/mobile-app
import { api } from '@semiont/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function DocumentList() {
  const { data, isLoading } = api.documents.list.useQuery();

  return (
    <FlatList
      data={data?.documents}
      renderItem={({ item }) => <DocumentCard document={item} />}
    />
  );
}
```

**Recommendation**: Start with React Native for fastest time-to-market, migrate to native later if needed.

## Browser Extensions

### Chrome/Firefox Extension

**Use Cases**:
- Annotate any webpage (not just Semiont documents)
- Capture highlights from research papers
- Tag entities in web content
- Save web pages as Semiont documents
- Quick annotation popup

**Architecture**:
- **Manifest**: V3 (Chrome) / V2 (Firefox)
- **Content Script**: Inject annotation UI into web pages
- **Background Service**: API calls to Semiont backend
- **API Client**: `@semiont/api-client`
- **Storage**: chrome.storage.sync for settings

**Key Features**:
- **Web Highlighter**: Select text on any page → create W3C annotation
- **Entity Detector**: Right-click → "Detect entities" → tag as Person, Organization, etc.
- **Save Page**: Right-click → "Save to Semiont" → create document from web page
- **Quick Popup**: Extension icon → search Semiont, recent annotations
- **Context Menu**: Integrate Semiont actions into browser context menu

**W3C Selector for Web Pages**:
```typescript
// Create W3C annotation for web page selection
const annotation = {
  "@context": "http://www.w3.org/ns/anno.jsonld",
  type: "Annotation",
  target: {
    source: window.location.href,  // Web page URL as source
    selector: [
      {
        type: "TextQuoteSelector",
        exact: selectedText,
        prefix: textBefore,
        suffix: textAfter
      },
      {
        type: "FragmentSelector",
        value: `char=${startOffset},${endOffset}`
      }
    ]
  },
  body: [
    {
      type: "TextualBody",
      purpose: "tagging",
      value: "Person"
    }
  ]
};

// POST to Semiont backend
await api.annotations.create(annotation);
```

**Starting Point**:
```typescript
// apps/browser-extension
// manifest.json
{
  "manifest_version": 3,
  "name": "Semiont Annotator",
  "permissions": ["activeTab", "storage", "contextMenus"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"]
  }]
}

// content.js - inject annotation UI
import { api } from '@semiont/api-client';

document.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  if (selection.toString()) {
    showAnnotationPopup(selection);
  }
});
```

### Safari Extension

**Use Cases**: Same as Chrome/Firefox

**Architecture**:
- **App Extension**: Safari App Extension (requires macOS app)
- **Shared Code**: TypeScript compiled to Safari extension
- **API Client**: `@semiont/api-client`

**Challenges**:
- Requires macOS app wrapper
- Different API than Chrome
- App Store distribution

## Desktop Applications

### Electron App

**Use Cases**:
- Offline-first annotation workspace
- Local document repository with cloud sync
- Powerful document editor
- Bulk operations on annotations

**Architecture**:
- **Framework**: Electron + React
- **Renderer**: Reuse Next.js frontend components
- **Main Process**: Node.js backend access
- **API Client**: `@semiont/api-client`
- **Storage**: SQLite for local cache

**Key Advantages**:
- **Reuse frontend components** from Next.js app
- Full filesystem access
- Native OS integration
- Offline-first with background sync

**Starting Point**:
```typescript
// apps/desktop-app
// main.ts
import { app, BrowserWindow } from 'electron';

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Load frontend
  win.loadFile('dist/index.html');
}

app.whenReady().then(createWindow);
```

**Reuse Strategy**: Build Next.js app as static export, load in Electron.

### Tauri App

**Use Cases**: Same as Electron, but smaller bundle size

**Architecture**:
- **Framework**: Tauri + React
- **Backend**: Rust (lightweight)
- **Frontend**: Reuse Next.js components
- **API Client**: `@semiont/api-client`

**Key Advantages**:
- Smaller bundle size than Electron (~10MB vs ~100MB)
- Better performance
- More secure (no Node.js in renderer)

**Challenges**:
- Rust backend (learning curve)
- Less mature ecosystem than Electron

## Specialized Integrations

### VS Code Extension

**Use Cases**:
- Annotate code snippets
- Tag code entities (functions, classes, variables)
- Link code to documentation
- Code review annotations

**Architecture**:
- **Extension API**: VS Code Extension API
- **Language**: TypeScript
- **API Client**: `@semiont/api-client`
- **UI**: VS Code WebView for annotation panel

**Key Features**:
- **Code Highlighter**: Select code → annotate
- **Entity Tagger**: Tag function/class as entity
- **Documentation Linker**: Link code to Semiont docs
- **Annotation Panel**: Sidebar showing code annotations
- **Quick Actions**: Command palette integration

**W3C Selector for Code**:
```typescript
const annotation = {
  target: {
    source: `file://${filePath}`,  // File path as source
    selector: [
      {
        type: "TextPositionSelector",
        start: lineStart,
        end: lineEnd
      },
      {
        type: "FragmentSelector",
        value: `line=${lineNumber}`
      }
    ]
  }
};
```

## Shared Infrastructure

### API Client Package

**Current**: `@semiont/api-client` (TypeScript)

**Future Clients**:
- **Swift Client**: Generate from OpenAPI spec (`openapi-generator`)
- **Kotlin Client**: Generate from OpenAPI spec
- **Python Client**: For Jupyter/CLI tools
- **Go Client**: For CLI tools
- **Rust Client**: For Tauri/CLI tools

**Strategy**: Use OpenAPI spec as source of truth, generate clients for each language.

### Core Package

**Current**: `@semiont/core` (TypeScript)

**Purpose**: Shared business logic, types, utilities

**Reusable Across**:
- Next.js web app
- React Native mobile app
- Electron desktop app
- Browser extensions

**Contents**:
- W3C annotation types
- Selector utilities
- Validation logic
- Common UI components (via `@semiont/ui` package)

### Authentication

**OAuth 2.0** works across all clients:

**Web/Desktop**: Standard OAuth flow
```typescript
// Redirect to /auth/signin → Google OAuth → callback
```

**Mobile**: Native OAuth via platform APIs
```swift
// iOS: ASWebAuthenticationSession
let session = ASWebAuthenticationSession(
  url: authURL,
  callbackURLScheme: "semiont",
  completionHandler: { callbackURL, error in
    // Extract JWT token
  }
)
```

**Browser Extension**: OAuth via browser identity API
```typescript
chrome.identity.launchWebAuthFlow({
  url: authURL,
  interactive: true
}, (responseUrl) => {
  // Extract JWT token
});
```

**CLI**: OAuth device flow
```bash
semiont login
# => Visit https://semiont.ai/device and enter code: XXXX-XXXX
```

### Offline Support

**Strategy**: Event-driven architecture with offline queue

**Local Storage**: SQLite/IndexedDB for offline data
**Event Queue**: Queue writes when offline, sync when online
**Conflict Resolution**: Last-write-wins or user-mediated

```typescript
// Offline queue pattern
class OfflineQueue {
  async queueWrite(operation: 'create' | 'update' | 'delete', resource: any) {
    await db.offlineQueue.add({
      operation,
      resource,
      timestamp: Date.now(),
      status: 'pending'
    });
  }

  async syncWhenOnline() {
    const queue = await db.offlineQueue.where('status').equals('pending').toArray();

    for (const item of queue) {
      try {
        await api[item.resource.type][item.operation](item.resource);
        await db.offlineQueue.update(item.id, { status: 'synced' });
      } catch (error) {
        await db.offlineQueue.update(item.id, { status: 'failed', error });
      }
    }
  }
}
```

## Design Principles

### 1. API-First Architecture

All clients communicate via REST API - no direct database access.

**Benefits**:
- Platform independence
- Security (backend validates all operations)
- Versioning (API versions)
- Scalability

### 2. W3C Compliance

All annotations follow W3C Web Annotation Data Model.

**Benefits**:
- Interoperability with other tools
- Data portability (JSON-LD export)
- Future-proof architecture

### 3. Type Safety

Use generated clients from OpenAPI spec.

**Benefits**:
- Compile-time validation
- IDE autocomplete
- Refactoring safety

### 4. Offline-First

Design for offline usage with background sync.

**Benefits**:
- Better UX (no blocking on network)
- Mobile/desktop apps work offline
- Resilient to network issues

### 5. Progressive Enhancement

Start simple, add features incrementally.

**Recommendation**:
1. Start with read-only (document viewer)
2. Add highlighting
3. Add entity tagging
4. Add document references
5. Add AI features (async operations)

## Implementation Roadmap

### Phase 1: Mobile App (React Native)
**Why First**: Fastest to market, reuses `@semiont/api-client`
**Timeline**: 2-3 months
**Features**: Document reader, highlights, entity tags

### Phase 2: Browser Extension
**Why Second**: High impact, enables web annotation
**Timeline**: 1-2 months
**Features**: Highlight any webpage, entity tagging, save to Semiont

### Phase 3: Desktop App (Electron)
**Why Third**: Offline-first power users
**Timeline**: 3-4 months
**Features**: Offline storage, bulk operations, sync

### Phase 4: VS Code Extension
**Why Fourth**: Developer-focused, specialized use case
**Timeline**: 1-2 months
**Features**: Code annotations, documentation linking

### Phase 5: Native Mobile Apps (iOS/Android)
**Why Last**: Polish and performance (after React Native validation)
**Timeline**: 6+ months each
**Features**: Native performance, platform integration

## Related Documentation

### Frontend Documentation
- [Frontend Architecture](./ARCHITECTURE.md) - Web app architecture
- [API Integration](./API-INTEGRATION.md) - API client usage, W3C annotations
- [Development Guide](./DEVELOPMENT.md) - Local development setup

### Backend Documentation
- [Backend README](../../backend/README.md) - REST API implementation
- [Job Worker](../../../docs/services/JOB-WORKER.md) - Async operations (for AI features)

### API Documentation
- [API Client](../../../packages/api-client/README.md) - Type-safe TypeScript client
- [OpenAPI Spec](../../../specs/README.md) - API specification for client generation (source in [../../../specs/src/](../../../specs/src/))

### System Documentation
- [System Architecture](../../../docs/ARCHITECTURE.md) - Overall platform design
- [W3C Web Annotation](../../../specs/docs/W3C-WEB-ANNOTATION.md) - Annotation model

### External Resources
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) - Standard
- [OpenAPI Generator](https://openapi-generator.tech/) - Client generation tool
- [React Native](https://reactnative.dev/) - Cross-platform mobile
- [Electron](https://www.electronjs.org/) - Desktop apps
- [VS Code Extension API](https://code.visualstudio.com/api) - VS Code extensions

---

**Status**: Planning / Ideas
**Next Steps**: Validate with user research, prioritize by demand
**Last Updated**: 2025-10-25
