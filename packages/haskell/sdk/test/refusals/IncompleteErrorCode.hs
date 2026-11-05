module IncompleteErrorCode where
import Semiont.ErrorCodes (BusRequestCode(..))
incomplete :: BusRequestCode -> Bool
incomplete BusRequestTimeout = True
