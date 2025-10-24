# Frontend Authorization Architecture

## Overview

The Semiont frontend implements a foundation for fine-grained access control with graceful 403 error handling and permission-aware UI components. While the current implementation is minimal, the architecture is designed to scale with future RBAC (Role-Based Access Control) requirements.

## Current State

### Basic Permission System

The current authorization system provides:

- **Global 403 error handling** via event-driven architecture
- **PermissionDeniedModal** for user-friendly access denial messages
- **Permission hooks** ready for expansion
- **Type-safe error handling** with proper status codes

### Core Components

#### 1. Permission Hooks (`src/hooks/useAuth.ts`)

```typescript
export function usePermissions() {
  // Currently returns basic permissions
  // Ready for backend integration
  return {
    canRead: boolean,
    canWrite: boolean,
    canAdmin: boolean,
    canManageUsers: boolean
  };
}
```

#### 2. PermissionDeniedModal (`src/components/PermissionDeniedModal.tsx`)

A modal that appears when users encounter 403 errors, providing:

- Clear explanation of why access was denied
- Current user context (shows signed-in account)
- Multiple recovery options:
  - **Go Back** - Return to previous page
  - **Go to Home** - Navigate to home page
  - **Switch Account** - Sign in with different credentials
  - **Request Access** - Placeholder for future access request workflow

#### 3. Global Event System (`src/lib/auth-events.ts`)

```typescript
// Dispatch 403 events from anywhere in the app
dispatch403Error('You need admin access for this action');

// Listen for permission denied events
onAuthEvent(AUTH_EVENTS.FORBIDDEN, (event) => {
  // Handle permission denial
});
```

## 403 Error Handling Flow

```mermaid
flowchart TD
    A[API Call] --> B{Response Status}
    B -->|403| C[APIError Thrown]
    C --> D[Global Error Handler]
    D --> E[dispatch403Error]
    E --> F[PermissionDeniedModal Shows]
    F --> G{User Choice}
    G -->|Go Back| H[Router.back()]
    G -->|Go Home| I[Navigate to /]
    G -->|Switch Account| J[Sign In Flow]
    G -->|Request Access| K[Future: Access Request]
```

### Error Detection Layers

1. **API Client Level** (`src/lib/api-client.ts`)
   - Throws `APIError` with status: 403
   - Preserves error context from backend

2. **React Query Level** (`src/app/providers.tsx`)
   ```typescript
   if (error instanceof APIError && error.status === 403) {
     dispatch403Error('Permission denied');
   }
   ```

3. **Component Level** (`src/hooks/useApiWithAuth.ts`)
   - Shows toast notification
   - Dispatches event for modal display

## Security Considerations

### Current Implementation

- **404 for unauthorized admin routes** - Routes return 404 instead of 403 to hide existence
- **No permission details in errors** - Generic messages prevent information leakage
- **Client-side permission checks** - Basic checks, not authoritative

### Best Practices

1. **Never trust client-side permissions** - Always validate on backend
2. **Fail closed** - Default to denying access
3. **Obscure sensitive routes** - Use 404s for admin/moderate paths
4. **Minimal error information** - Don't reveal system internals

## Future Roadmap

### Near-term Enhancements

#### 1. Enhanced Error Responses

```typescript
interface PermissionError {
  status: 403;
  code: 'PERMISSION_DENIED';
  details: {
    resource: 'document:123';
    action: 'edit';
    required: ['doc.edit', 'team.member'];
    userHas: ['doc.view'];
    suggestion: 'Request edit access from owner';
  }
}
```

#### 2. Permission-Aware Components

```typescript
function DocumentEditor({ document }) {
  const permissions = useDocumentPermissions(document.id);

  if (!permissions.canEdit) {
    return <ReadOnlyView document={document} />;
  }

  return <FullEditor document={document} />;
}
```

#### 3. Optimistic Permission Checking

```typescript
// Check before making API call
const { canDelete } = useResourcePermissions(resourceId);
if (!canDelete) {
  showPermissionModal({
    action: 'delete',
    resource: 'document'
  });
  return;
}
```

### Long-term Vision

#### Fine-Grained RBAC

- **Resource-level permissions** - Per-document, per-collection access
- **Team-based access** - Organizational hierarchy support
- **Temporal permissions** - Time-limited access grants
- **Delegated permissions** - Acting on behalf of others

#### Access Request Workflow

```typescript
interface AccessRequest {
  resource: string;
  permissions: string[];
  justification: string;
  duration?: number;
  approver?: string;
}
```

#### Permission Caching Strategy

```typescript
const permissionCache = new Map({
  'document:123': ['read', 'comment'],
  'collection:abc': ['read', 'write'],
  'global': ['create_document']
});
```

## Integration with Authentication

Authorization works in tandem with authentication:

- **Authentication** (401) - "Who are you?" - See [AUTHENTICATION.md](./AUTHENTICATION.md)
- **Authorization** (403) - "What can you do?"

Both systems use the same event-driven architecture for consistent error handling and user experience.

## Usage Examples

### Checking Permissions

```typescript
function MyComponent() {
  const { canWrite } = usePermissions();

  if (!canWrite) {
    return <ReadOnlyMessage />;
  }

  return <EditableContent />;
}
```

### Handling Permission Errors

```typescript
// Using React Query mutation
const deleteMutation = api.documents.delete.useMutation();

try {
  await deleteMutation.mutateAsync(documentId);
} catch (error) {
  if (error instanceof APIError && error.status === 403) {
    // Automatically handled by global error handler
    // PermissionDeniedModal will appear
  }
}
```

### Protected UI Elements

```typescript
function ActionButtons({ document }) {
  const { canEdit, canDelete } = useDocumentPermissions(document);

  return (
    <>
      <Button
        disabled={!canEdit}
        title={!canEdit ? 'You need edit permission' : ''}
      >
        Edit
      </Button>
      <Button
        disabled={!canDelete}
        title={!canDelete ? 'You need delete permission' : ''}
      >
        Delete
      </Button>
    </>
  );
}
```

## Testing

### Manual Testing

1. **Trigger 403 error** - Access restricted resource
2. **Verify modal appears** - PermissionDeniedModal should show
3. **Test recovery options** - Each button should work correctly
4. **Check toast notifications** - Brief error message should appear

### Automated Testing

```typescript
describe('Authorization', () => {
  it('shows PermissionDeniedModal on 403', async () => {
    // Mock API to return 403
    server.use(
      http.get('/api/admin/*', () => {
        return new Response('Forbidden', { status: 403 });
      })
    );

    // Trigger API call
    await userEvent.click(screen.getByText('Admin Action'));

    // Verify modal appears
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
  });
});
```

## Configuration

### Environment Variables

Currently no specific authorization environment variables. Future additions might include:

```bash
# Future configuration
NEXT_PUBLIC_ENABLE_RBAC=true
NEXT_PUBLIC_PERMISSION_CACHE_TTL=300
NEXT_PUBLIC_ACCESS_REQUEST_ENABLED=true
```

### Permission Definitions

Future permission configuration structure:

```typescript
const permissions = {
  document: ['create', 'read', 'update', 'delete', 'share'],
  collection: ['create', 'read', 'update', 'delete', 'manage'],
  admin: ['users', 'security', 'devops', 'audit']
};
```

## Troubleshooting

### Common Issues

1. **Modal not appearing on 403**
   - Check if `dispatch403Error` is being called
   - Verify PermissionDeniedModal is mounted in layout
   - Check browser console for errors

2. **Incorrect permissions shown**
   - Permissions currently hardcoded in `usePermissions`
   - Backend integration pending

3. **403 errors not caught**
   - Ensure using `APIError` class from api-client
   - Check error instanceof APIError

## Related Documentation

- [Authentication Architecture](./AUTHENTICATION.md) - 401 handling and session management
- [Backend API Documentation](../../backend/docs/API.md) - API error handling details
- [Backend RBAC](/docs/SECURITY.md) - Server-side permission system

## Contributing

When adding new permission-related features:

1. **Use existing patterns** - Event system, modals, hooks
2. **Type everything** - Full TypeScript coverage required
3. **Consider future RBAC** - Design for expansion
4. **Document permissions** - Clear comments on what each permission allows
5. **Test error paths** - Ensure graceful degradation