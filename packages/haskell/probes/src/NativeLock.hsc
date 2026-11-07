{-# LANGUAGE ForeignFunctionInterface #-}

module NativeLock (tryNativeLock, withNativeLock, withWaitingLock) where

#include <sys/file.h>

import Control.Exception (bracket)
import Foreign.C.Error (eAGAIN, eWOULDBLOCK, getErrno, throwErrno)
import Foreign.C.Types (CInt(..))
import System.Posix.IO (OpenMode(ReadWrite), closeFd, defaultFileFlags, openFd)
import System.Posix.Types (Fd(..))

foreign import ccall unsafe "flock" nativeFlock :: CInt -> CInt -> IO CInt

tryNativeLock :: Fd -> IO Bool
tryNativeLock (Fd descriptor) = do
  result <- nativeFlock descriptor (#{const LOCK_EX} + #{const LOCK_NB})
  if result == 0 then pure True else do
    reason <- getErrno
    if reason == eAGAIN || reason == eWOULDBLOCK
      then pure False
      else throwErrno "flock"

withNativeLock :: FilePath -> (Bool -> IO result) -> IO result
withNativeLock path action =
  bracket (openFd path ReadWrite defaultFileFlags) closeFd $ \descriptor ->
    tryNativeLock descriptor >>= action

withWaitingLock :: IO () -> FilePath -> IO result -> IO result
withWaitingLock wait path action =
  bracket (openFd path ReadWrite defaultFileFlags) closeFd $ \descriptor -> do
    let acquire = do
          held <- tryNativeLock descriptor
          if held then action else wait >> acquire
    acquire
