# Backend Security Tests

This directory contains comprehensive security tests for the Semiont backend application.

## 🎯 Test Coverage Overview

Our backend security tests provide comprehensive coverage across all security-critical components:

### **Authentication & Authorization Tests**
- **JWT Service Tests** (`auth/jwt.test.ts`): Token generation, validation, and security
- **OAuth Service Tests** (`auth/oauth.test.ts`): Google token verification and user management  
- **Auth Middleware Tests** (`middleware/auth.test.ts`): Request authentication and authorization
- **Admin API Tests** (`api/admin-endpoints.test.ts`): Admin endpoint protection and data security

### **Security Requirements Tests**
- **Backend Security Tests** (`backend-security.test.ts`): Core security requirements and best practices

## 🔐 Security Test Categories

### **1. Authentication Security**
- JWT token generation with secure algorithms
- Token validation and expiration handling
- Google OAuth token verification
- User session management and security
- Authentication middleware enforcement

### **2. Authorization Security**
- Admin role verification and enforcement
- User permission checks and validation
- Resource access control verification
- API endpoint protection testing

### **3. Information Disclosure Prevention**
- Sensitive data leakage prevention
- Error message sanitization
- Database connection string protection
- User credential security verification

### **4. Input Validation & Data Security**
- Request payload validation
- SQL injection prevention verification
- Cross-site scripting (XSS) protection
- Data sanitization and encoding

### **5. Infrastructure Security**
- Database connection security
- Environment variable protection
- Configuration security validation
- Network request security verification

## Test Files

### `backend-security.test.ts`
**Comprehensive security requirements documentation** that verifies:

- ✅ **Authentication requirements** - JWT tokens, Authorization headers
- ✅ **Authorization checks** - Admin privilege verification from database  
- ✅ **Error message security** - No sensitive data in error responses
- ✅ **HTTP status codes** - Proper 401/403/500 responses
- ✅ **Information disclosure prevention** - No leakage of internal details
- ✅ **Middleware chain verification** - Proper auth → admin → handler flow
- ✅ **Edge case handling** - Malformed tokens, missing users, etc.
- ✅ **API security best practices** - OWASP compliance

## 🚀 Running Security Tests

### **Run All Security Tests**
```bash
npm run test:security
```

### **Run Specific Test Suites**
```bash
# JWT authentication tests
npm test -- auth/jwt.test.ts

# OAuth service tests  
npm test -- auth/oauth.test.ts

# Middleware security tests
npm test -- middleware/auth.test.ts

# Admin API security tests
npm test -- api/admin-endpoints.test.ts

# Core security requirements
npm test -- backend-security.test.ts
```

### **Run with Coverage**
```bash
npm test -- --coverage
```

### **Watch Mode for Development**
```bash
npm test -- --watch
```

## 📊 Test Metrics & Coverage

### **Security Test Statistics**
- **Total Security Tests**: 80+ comprehensive test cases
- **Authentication Tests**: 25+ test scenarios
- **Authorization Tests**: 20+ test scenarios  
- **Data Security Tests**: 15+ test scenarios
- **Infrastructure Tests**: 10+ test scenarios
- **Integration Tests**: 10+ test scenarios

### **Coverage Requirements**
- **Minimum Coverage**: 90% for all security-critical code
- **Authentication Code**: 95+ % coverage required
- **Admin Endpoints**: 100% coverage required
- **Middleware**: 95+ % coverage required

## Security Requirements Verified

### 🔐 **Authentication Flow**
1. **JWT Token Required**: All admin endpoints require `Authorization: Bearer <token>`
2. **Server-Side Validation**: Tokens validated via `OAuthService.getUserFromToken()`
3. **Database Lookup**: User details fetched from database, not trusted from token claims

### 🛡️ **Authorization Controls**  
1. **Admin Check**: `user.isAdmin === true` required from database
2. **Middleware Chain**: `authMiddleware` → `adminMiddleware` → route handler
3. **Role Verification**: Admin status verified server-side, never client-side

### 📝 **Error Handling Security**
1. **Generic Messages**: Only approved error messages returned to clients
2. **No Information Disclosure**: No database strings, file paths, or stack traces
3. **Proper Status Codes**: 401 for auth, 403 for authorization, 500 for server errors

### 🔍 **Protected Operations**
All admin endpoints properly protected:
- `GET /api/admin/users` - List all users
- `GET /api/admin/users/stats` - User statistics  
- `PATCH /api/admin/users/:id` - Update user
- `DELETE /api/admin/users/:id` - Delete user

## What These Tests Prevent

| Security Risk | Prevention Method | Test Coverage |
|---------------|------------------|---------------|
| **Authentication Bypass** | JWT token validation required | ✅ |
| **Privilege Escalation** | Database admin check required | ✅ |
| **Information Disclosure** | Generic error messages only | ✅ |
| **SQL Injection** | Prisma ORM usage verified | ✅ |
| **Token Manipulation** | Server-side validation only | ✅ |
| **Edge Case Exploits** | Malformed data handling | ✅ |

## Comparison with Frontend Security

| Aspect | Frontend (Fixed) | Backend (Already Secure) |
|--------|------------------|--------------------------|
| **Issue** | 307 redirects with content leakage | Already returning proper 403 JSON |
| **Fix** | Server-side auth wrapper | Already had proper middleware |
| **Response** | 200 with access denied page | 403 with JSON error |
| **Tests** | Added regression prevention | Added documentation tests |

## Security Test Philosophy

These tests follow a **documentation-driven approach**:

1. **Document Requirements**: What security measures should exist
2. **Verify Implementation**: Confirm measures are properly implemented  
3. **Prevent Regression**: Catch if security controls are removed
4. **Educational Value**: Help developers understand security expectations

## Maintenance

Run these tests before any changes to:
- Authentication middleware (`src/middleware/auth.ts`)
- Admin route handlers (`src/index.ts` admin routes)
- OAuth service (`src/auth/oauth.ts`)
- Database schema (user roles/permissions)

**If any security test fails, do not merge changes until security implications are reviewed.**

## Integration with CI/CD

These tests should be included in:
- Pre-commit hooks
- Pull request validation  
- Deployment pipelines
- Security auditing processes

The tests are designed to be fast and reliable for continuous integration environments.