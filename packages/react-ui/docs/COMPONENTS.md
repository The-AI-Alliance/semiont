# Components

Component library reference for `@semiont/react-ui`.

## Overview

The library provides components organized by functionality:

- **Authentication Components** - Sign-in, sign-up, and error displays
- **Resource Viewers** - Display and interact with resources
- **Layout Components** - Page structure and navigation
- **Annotation Components** - Semantic markup and collaboration
- **Modals & Overlays** - Dialogs and pop-ups
- **UI Elements** - Toolbars, toasts, and widgets
- **Accessibility** - Screen reader and keyboard navigation support

All components are framework-agnostic. Components that need routing accept a `Link` component as a prop, allowing you to use Next.js Link, React Router Link, or any other router.

## Resource Components

### ResourceViewer

Primary component for displaying resources with annotations.

```tsx
import { ResourceViewer } from '@semiont/react-ui';

<ResourceViewer
  resource={resource}
  view="browse" // or "annotate"
  onViewChange={(view) => setView(view)}
/>
```

**Props:**
- `resource` - Resource object from API
- `view` - Current view mode ('browse' | 'annotate')
- `onViewChange?` - Callback when view mode changes

**Features:**
- Tabbed interface (Browse, Annotate, History)
- CodeMirror integration for syntax highlighting
- Annotation overlay
- Responsive layout

### BrowseView

Read-only resource view.

```tsx
import { BrowseView } from '@semiont/react-ui';

<BrowseView resource={resource} />
```

### AnnotateView

Annotation interface for resources.

```tsx
import { AnnotateView } from '@semiont/react-ui';

<AnnotateView resource={resource} />
```

### AnnotationHistory

Display annotation history and events.

```tsx
import { AnnotationHistory } from '@semiont/react-ui';

<AnnotationHistory resourceUri={rUri} />
```

---

## Authentication Components

### SignInForm

Sign-in form with Google OAuth and optional credentials-based authentication.

```tsx
import { SignInForm } from '@semiont/react-ui';
import Link from 'next/link'; // Or your router's Link

<SignInForm
  onGoogleSignIn={async () => signIn('google')}
  onCredentialsSignIn={async (email, password) => signIn('credentials', { email, password })}
  showCredentialsAuth={true}
  error={errorMessage}
  Link={Link}
  translations={{
    pageTitle: 'Sign In',
    welcomeBack: 'Welcome back to Semiont',
    // ... other translation keys
  }}
/>
```

**Props:**
- `onGoogleSignIn` - Callback for Google OAuth sign-in
- `onCredentialsSignIn?` - Optional callback for email/password sign-in
- `showCredentialsAuth?` - Whether to show credentials auth form (default: false)
- `error?` - Error message to display
- `Link` - Link component from your router
- `translations` - Translation strings for all UI text

### SignUpForm

Google OAuth sign-up form.

```tsx
import { SignUpForm } from '@semiont/react-ui';
import Link from 'next/link';

<SignUpForm
  onSignUp={async () => signIn('google', { callbackUrl: '/welcome' })}
  Link={Link}
  translations={{
    pageTitle: 'Join Semiont',
    signUpPrompt: 'Create your account',
    // ... other translation keys
  }}
/>
```

**Props:**
- `onSignUp` - Callback when user initiates sign-up
- `Link` - Link component from your router
- `translations` - Translation strings

**Features:**
- Loading state during OAuth flow
- Error handling with user feedback
- Accessible form controls

### AuthErrorDisplay

Display authentication error messages.

```tsx
import { AuthErrorDisplay } from '@semiont/react-ui';
import Link from 'next/link';

<AuthErrorDisplay
  errorType="AccessDenied" // or "Configuration", "Verification", etc.
  Link={Link}
  translations={{
    pageTitle: 'Authentication Error',
    tryAgain: 'Try signing in again',
    // ... error message translations
  }}
/>
```

**Props:**
- `errorType` - Type of authentication error
- `Link` - Link component from your router
- `translations` - Translation strings including error messages

**Supported Error Types:**
- `Configuration` - Server configuration issues
- `AccessDenied` - User not authorized
- `Verification` - Email verification failed
- Other types show generic error message

### WelcomePage

Welcome page for new users after sign-up.

```tsx
import { WelcomePage } from '@semiont/react-ui';
import Link from 'next/link';

<WelcomePage
  userName={user.name}
  Link={Link}
  translations={{
    // ... translation keys
  }}
/>
```

---

## Layout Components

### PageLayout

Standard page layout with header, sidebar, and content.

```tsx
import { PageLayout } from '@semiont/react-ui';

<PageLayout
  header={<Header />}
  sidebar={<Sidebar />}
  showSidebar={true}
>
  {content}
</PageLayout>
```

### UnifiedHeader

Application header with navigation and user menu.

```tsx
import { UnifiedHeader } from '@semiont/react-ui';

<UnifiedHeader
  showUserMenu={isAuthenticated}
  userName={user?.name}
/>
```

### LeftSidebar

Collapsible sidebar navigation.

```tsx
import { LeftSidebar } from '@semiont/react-ui';

<LeftSidebar isOpen={sidebarOpen} onToggle={toggleSidebar}>
  <NavigationMenu />
</LeftSidebar>
```

### NavigationMenu

Main navigation menu.

```tsx
import { NavigationMenu } from '@semiont/react-ui';

<NavigationMenu />
```

**Features:**
- Keyboard navigation
- Active route highlighting
- Responsive design

### Footer

Application footer with links.

```tsx
import { Footer } from '@semiont/react-ui';

<Footer />
```

---

## Annotation Components

See [ANNOTATIONS.md](ANNOTATIONS.md) for detailed annotation documentation.

### AnnotateToolbar

Toolbar for annotation tools.

```tsx
import { AnnotateToolbar } from '@semiont/react-ui';

<AnnotateToolbar
  currentTool={tool}
  onToolChange={setTool}
/>
```

### Annotation Panels

```tsx
import {
  HighlightPanel,
  CommentsPanel,
  TaggingPanel,
  ReferencesPanel,
  AssessmentPanel,
  JsonLdPanel,
  UnifiedAnnotationsPanel
} from '@semiont/react-ui';

// Use specific panel
<HighlightPanel resourceUri={rUri} />

// Or unified panel for all annotations
<UnifiedAnnotationsPanel resourceUri={rUri} />
```

---

## Modals & Overlays

### SessionExpiredModal

Displays when user session expires.

```tsx
import { SessionExpiredModal } from '@semiont/react-ui';

<SessionExpiredModal />
```

**Features:**
- Auto-detects session expiration
- Prompts user to re-authenticate
- Redirects after sign-in

### KeyboardShortcutsHelpModal

Displays keyboard shortcuts help.

```tsx
import { KeyboardShortcutsHelpModal } from '@semiont/react-ui';

<KeyboardShortcutsHelpModal
  isOpen={showHelp}
  onClose={() => setShowHelp(false)}
/>
```

### ProposeEntitiesModal

Entity proposal interface.

```tsx
import { ProposeEntitiesModal } from '@semiont/react-ui';

<ProposeEntitiesModal
  isOpen={showModal}
  onClose={() => setShowModal(false)}
  resourceUri={rUri}
/>
```

---

## UI Elements

### Toolbar

Customizable toolbar container.

```tsx
import { Toolbar } from '@semiont/react-ui';

<Toolbar>
  <Toolbar.Section>
    <button>Action 1</button>
    <button>Action 2</button>
  </Toolbar.Section>
  <Toolbar.Section align="right">
    <button>Settings</button>
  </Toolbar.Section>
</Toolbar>
```

### Toast

Toast notification system.

```tsx
import { ToastProvider, useToast } from '@semiont/react-ui';

// In providers
<ToastProvider>{children}</ToastProvider>

// In components
function MyComponent() {
  const toast = useToast();

  const handleSave = () => {
    toast.success('Saved successfully');
    // or
    toast.error('Save failed');
    // or
    toast.info('Processing...');
  };
}
```

### LiveRegion

Accessibility live region for announcements.

```tsx
import { LiveRegionProvider, useLiveRegion } from '@semiont/react-ui';

// In providers
<LiveRegionProvider>{children}</LiveRegionProvider>

// In components
function MyComponent() {
  const { announce } = useLiveRegion();

  const handleAction = () => {
    announce('Action completed');
  };
}
```

---

## Session Components

### SessionTimer

Displays time until session expires.

```tsx
import { SessionTimer } from '@semiont/react-ui';

<SessionTimer />
```

### SessionExpiryBanner

Warning banner before session expires.

```tsx
import { SessionExpiryBanner } from '@semiont/react-ui';

<SessionExpiryBanner />
```

**Features:**
- Shows 5 minutes before expiration
- Auto-dismisses when session is refreshed
- Accessible announcements

### UserMenuSkeleton

Loading skeleton for user menu.

```tsx
import { UserMenuSkeleton } from '@semiont/react-ui';

<UserMenuSkeleton />
```

---

## Accessibility Components

### SkipLinks

Skip navigation links for keyboard users.

```tsx
import { SkipLinks } from '@semiont/react-ui';

<SkipLinks
  links={[
    { href: '#main-content', label: 'Skip to main content' },
    { href: '#navigation', label: 'Skip to navigation' }
  ]}
/>
```

---

## Branding Components

### SemiontBranding

Semiont logo and branding.

```tsx
import { SemiontBranding } from '@semiont/react-ui';

<SemiontBranding size="large" />
```

---

## Utility Components

### ErrorBoundary

React error boundary for graceful error handling.

```tsx
import { ErrorBoundary } from '@semiont/react-ui';

<ErrorBoundary fallback={<ErrorPage />}>
  {children}
</ErrorBoundary>
```

### CodeMirrorRenderer

CodeMirror-based code viewer.

```tsx
import { CodeMirrorRenderer } from '@semiont/react-ui';

<CodeMirrorRenderer
  content={code}
  language="javascript"
  readOnly={true}
/>
```

### DetectionProgressWidget

Progress indicator for entity detection.

```tsx
import { DetectionProgressWidget } from '@semiont/react-ui';

<DetectionProgressWidget
  progress={0.5}
  status="Processing..."
/>
```

### StatusDisplay

Display system status messages.

```tsx
import { StatusDisplay } from '@semiont/react-ui';

<StatusDisplay
  status="info" // or "success", "warning", "error"
  message="System is running normally"
/>
```

### ResourceTagsInline

Display resource tags inline.

```tsx
import { ResourceTagsInline } from '@semiont/react-ui';

<ResourceTagsInline
  tags={['important', 'review', 'draft']}
  onTagClick={(tag) => filterByTag(tag)}
/>
```

---

## Component Patterns

### With Translations

All components use the translation system:

```tsx
import { useTranslations } from '@semiont/react-ui';

function MyComponent() {
  const t = useTranslations('MyComponent');

  return <button>{t('save')}</button>;
}
```

### With Routing

Components that need navigation use routing context:

```tsx
import { useRouting } from '@semiont/react-ui';

function MyComponent() {
  const { Link, routes } = useRouting();

  return <Link href={routes.home}>Home</Link>;
}
```

### With API Hooks

Components fetch data using API hooks:

```tsx
import { useResources } from '@semiont/react-ui';

function MyComponent() {
  const resources = useResources();
  const { data, isLoading } = resources.list.useQuery();

  if (isLoading) return <Spinner />;

  return <ResourceList items={data} />;
}
```

## Styling

Components use Tailwind CSS utility classes. To customize:

```tsx
// Pass className prop
<NavigationMenu className="custom-nav" />

// Or use Tailwind config
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: '#your-color'
      }
    }
  }
}
```

## Accessibility

All components follow WCAG 2.1 AA guidelines:

- ✅ Keyboard navigation
- ✅ Screen reader support
- ✅ Focus management
- ✅ ARIA labels and roles
- ✅ Color contrast compliance

Test with:

```tsx
import { axe } from 'jest-axe';

it('should have no accessibility violations', async () => {
  const { container } = render(<MyComponent />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

## See Also

- [PROVIDERS.md](PROVIDERS.md) - Context providers for components
- [API-INTEGRATION.md](API-INTEGRATION.md) - API hooks used by components
- [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md) - Translation usage
- [ROUTING.md](ROUTING.md) - Navigation in components
- [ANNOTATIONS.md](ANNOTATIONS.md) - Annotation components
- [TESTING.md](TESTING.md) - Testing components
