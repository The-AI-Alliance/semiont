/* Native synchronization and directory ownership for the shared sign-in store.
   The range and access policy come from the protocol, not this binding. */
#include "semiont_store_policy.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <wchar.h>

static wchar_t *store_path(const char *path) {
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
    if (!count) return NULL;
    wchar_t *wide = malloc((size_t)count * sizeof(wchar_t));
    if (!wide) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, count)) {
        DWORD error = GetLastError(); free(wide); SetLastError(error); return NULL;
    }
    if (wcsncmp(wide, L"\\\\?\\", 4) == 0 || wcsncmp(wide, L"\\\\.\\", 4) == 0) return wide;
    DWORD size = GetFullPathNameW(wide, 0, NULL, NULL);
    if (!size) { DWORD error = GetLastError(); free(wide); SetLastError(error); return NULL; }
    wchar_t *full = malloc((size_t)size * sizeof(wchar_t));
    if (!full) { free(wide); SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    DWORD copied = GetFullPathNameW(wide, size, full, NULL);
    free(wide);
    if (!copied || copied >= size) {
        DWORD error = copied ? ERROR_INSUFFICIENT_BUFFER : GetLastError();
        free(full); SetLastError(error); return NULL;
    }
    int unc = full[0] == L'\\' && full[1] == L'\\';
    const wchar_t *prefix = unc ? L"\\\\?\\UNC\\" : L"\\\\?\\";
    size_t prefix_size = wcslen(prefix), skip = unc ? 2 : 0, length = wcslen(full);
    wchar_t *extended = malloc((prefix_size + length - skip + 1) * sizeof(wchar_t));
    if (!extended) { free(full); SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    memcpy(extended, prefix, prefix_size * sizeof(wchar_t));
    memcpy(extended + prefix_size, full + skip, (length - skip + 1) * sizeof(wchar_t));
    free(full);
    return extended;
}

int semiont_store_open(const char *path, intptr_t *opened) {
    wchar_t *wide = store_path(path);
    if (!wide) return (int)GetLastError();
    HANDLE handle = CreateFileW(wide, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD error = handle == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    free(wide);
    if (!error) *opened = (intptr_t)handle;
    return (int)error;
}

int semiont_store_try_lock(intptr_t opened) {
    OVERLAPPED where;
    memset(&where, 0, sizeof(where));
    where.OffsetHigh = SEMIONT_LOCK_HIGH;
    if (LockFileEx((HANDLE)opened, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0, SEMIONT_LOCK_BYTES, 0, &where)) return 1;
    DWORD error = GetLastError();
    return error == ERROR_LOCK_VIOLATION ? 0 : -(int)error;
}
int semiont_store_close(intptr_t opened) {
    return CloseHandle((HANDLE)opened) ? 0 : (int)GetLastError();
}

int semiont_store_file_mode(const char *path) { (void)path; return 0; }

static int same_ace(const ACE_HEADER *left, const ACE_HEADER *right) {
    if (left->AceType != ACCESS_ALLOWED_ACE_TYPE || right->AceType != ACCESS_ALLOWED_ACE_TYPE
        || left->AceFlags != right->AceFlags) return 0;
    const ACCESS_ALLOWED_ACE *a = (const ACCESS_ALLOWED_ACE *)left;
    const ACCESS_ALLOWED_ACE *b = (const ACCESS_ALLOWED_ACE *)right;
    return a->Mask == b->Mask && EqualSid((PSID)&a->SidStart, (PSID)&b->SidStart);
}
static int same_acl(PSECURITY_DESCRIPTOR actual, PSECURITY_DESCRIPTOR expected) {
    SECURITY_DESCRIPTOR_CONTROL actual_control, expected_control;
    DWORD revision;
    PACL a, b;
    BOOL present, defaulted;
    if (!GetSecurityDescriptorControl(actual, &actual_control, &revision)
        || !GetSecurityDescriptorControl(expected, &expected_control, &revision)) return -(int)GetLastError();
    if ((actual_control & SE_DACL_PROTECTED) != (expected_control & SE_DACL_PROTECTED)) return 0;
    if (!GetSecurityDescriptorDacl(actual, &present, &a, &defaulted)) return -(int)GetLastError();
    if (!present || !a) return 0;
    if (!GetSecurityDescriptorDacl(expected, &present, &b, &defaulted)) return -(int)GetLastError();
    if (!present || !b) return -(int)ERROR_INVALID_ACL;
    if (a->AceCount != b->AceCount) return 0;
    /* Allowed entries commute. Match each one once, retaining multiplicity. */
    unsigned char *used = calloc(b->AceCount, 1);
    if (!used) return -(int)ERROR_NOT_ENOUGH_MEMORY;
    int equal = 1;
    for (DWORD i = 0; i < a->AceCount && equal > 0; ++i) {
        ACE_HEADER *first;
        if (!GetAce(a, i, (LPVOID *)&first)) { equal = -(int)GetLastError(); break; }
        int found = 0;
        for (DWORD j = 0; j < b->AceCount && !found; ++j) {
            ACE_HEADER *second;
            if (!used[j]) {
                if (!GetAce(b, j, (LPVOID *)&second)) { equal = -(int)GetLastError(); break; }
                if (same_ace(first, second)) { used[j] = 1; found = 1; }
            }
        }
        if (!found && equal > 0) equal = 0;
    }
    free(used);
    return equal;
}

int semiont_store_owner_only(const char *path) {
    DWORD error = ERROR_SUCCESS, needed = 0;
    HANDLE token = NULL;
    TOKEN_USER *user = NULL;
    LPWSTR sid = NULL;
    wchar_t *wide = NULL, *policy = NULL;
    PSECURITY_DESCRIPTOR expected = NULL, actual = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return (int)GetLastError();
    GetTokenInformation(token, TokenUser, NULL, 0, &needed);
    user = malloc(needed);
    if (!user) { error = ERROR_NOT_ENOUGH_MEMORY; goto finished; }
    if (!GetTokenInformation(token, TokenUser, user, needed, &needed)) { error = GetLastError(); goto finished; }
    if (!ConvertSidToStringSidW(user->User.Sid, &sid)) { error = GetLastError(); goto finished; }
    const char *source = SEMIONT_ACCESS_LIST;
    const char *placeholder = "{owner}";
    size_t placeholder_size = strlen(placeholder);
    const char *marker = strstr(source, placeholder);
    if (!marker || strstr(marker + placeholder_size, placeholder)) { error = ERROR_INVALID_DATA; goto finished; }
    size_t before = (size_t)(marker-source), after = strlen(marker+placeholder_size), owner = wcslen(sid);
    policy = malloc((before+owner+after+1)*sizeof(wchar_t));
    if (!policy) { error = ERROR_NOT_ENOUGH_MEMORY; goto finished; }
    for (size_t i=0; i<before; ++i) policy[i]=(wchar_t)(unsigned char)source[i];
    memcpy(policy+before, sid, owner*sizeof(wchar_t));
    for (size_t i=0; i<=after; ++i) policy[before+owner+i]=(wchar_t)(unsigned char)marker[placeholder_size+i];
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(policy, SDDL_REVISION_1, &expected, NULL)) {
        error = GetLastError(); goto finished;
    }
    wide = store_path(path);
    if (!wide) { error = GetLastError(); goto finished; }
    error = GetNamedSecurityInfoW(wide, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        NULL, NULL, NULL, NULL, &actual);
    if (error) goto finished;
    int matches = same_acl(actual, expected);
    if (matches < 0) { error = (DWORD)(-matches); goto finished; }
    if (matches) goto finished;
    PACL acl;
    BOOL present, defaulted;
    if (!GetSecurityDescriptorDacl(expected, &present, &acl, &defaulted) || !present) {
        error = GetLastError(); goto finished;
    }
    error = SetNamedSecurityInfoW(wide, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
finished:
    if (actual) LocalFree(actual);
    if (expected) LocalFree(expected);
    if (sid) LocalFree(sid);
    free(policy); free(wide); free(user);
    if (token) CloseHandle(token);
    return (int)error;
}
#else
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>

int semiont_store_open(const char *path, intptr_t *opened) {
    int descriptor = open(path, O_RDONLY | O_CREAT | O_CLOEXEC, SEMIONT_FILE_MODE);
    if (descriptor < 0) return errno;
    *opened = descriptor;
    return 0;
}
int semiont_store_try_lock(intptr_t opened) {
    if (!flock((int)opened, LOCK_EX | LOCK_NB)) return 1;
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR ? 0 : -errno;
}
int semiont_store_close(intptr_t opened) { return close((int)opened) ? errno : 0; }
int semiont_store_owner_only(const char *path) { return chmod(path, SEMIONT_DIRECTORY_MODE) ? errno : 0; }
int semiont_store_file_mode(const char *path) { return chmod(path, SEMIONT_FILE_MODE) ? errno : 0; }
#endif
