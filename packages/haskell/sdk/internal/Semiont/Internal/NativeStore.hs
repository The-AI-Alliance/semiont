{-# LANGUAGE CPP, ForeignFunctionInterface #-}
module Semiont.Internal.NativeStore (withLock, ownerOnly, fileMode) where

import Control.Exception (bracket)
import Control.Monad (unless, when)
import Foreign (Ptr, alloca, peek, IntPtr(..))
import Foreign.C (CInt(..), CString)
#ifdef mingw32_HOST_OS
import qualified Data.ByteString as Bytes
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
#else
import System.Posix.Internals (withFilePath)
#endif
import qualified Semiont.Retry as Retry

foreign import ccall safe "semiont_store_open" openNative :: CString -> Ptr IntPtr -> IO CInt
foreign import ccall unsafe "semiont_store_try_lock" tryNative :: IntPtr -> IO CInt
foreign import ccall unsafe "semiont_store_close" closeNative :: IntPtr -> IO CInt
foreign import ccall safe "semiont_store_file_mode" fileNative :: CString -> IO CInt
foreign import ccall safe "semiont_store_owner_only" ownerNative :: CString -> IO CInt

withPath :: FilePath -> (CString -> IO result) -> IO result
withPath path action = do
  when ('\0' `elem` path) (ioError (userError "Native store path contains a NUL"))
#ifdef mingw32_HOST_OS
  when (any (\char -> char>='\xD800' && char<='\xDFFF') path) (ioError (userError "Native store path is not valid Unicode"))
  Bytes.useAsCString (encodeUtf8 (Text.pack path)) action
#else
  withFilePath path action
#endif

checked :: String -> CInt -> IO ()
checked operation code = unless (code==0) (ioError (userError (operation++" failed with native error "++show code)))
ownerOnly :: FilePath -> IO ()
ownerOnly path = withPath path ownerNative >>= checked "State-home ownership"
fileMode :: FilePath -> IO ()
fileMode filename = withPath filename fileNative >>= checked "Sign-in file mode"

withLock :: Retry.RetryOptions -> Integer -> FilePath -> IO result -> IO result
withLock time retryMs path action = do
  when (retryMs<=0) (ioError (userError "Native lock retry interval must be positive"))
  let open = withPath path $ \name -> alloca $ \slot -> do
        openNative name slot >>= checked "Open sign-in lock"
        peek slot
      close handle = closeNative handle >>= checked "Close sign-in lock"
      hold handle = do
        locked <- tryNative handle
        if locked==1 then action else if locked<0 then checked "Lock sign-in store" (-locked) >> hold handle else do
          now <- Retry.retryNow time
          Retry.retryWaitUntil time (now+retryMs*1000000)
          hold handle
  bracket open close hold
