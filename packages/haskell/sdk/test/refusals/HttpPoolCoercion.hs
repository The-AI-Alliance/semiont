module HttpPoolCoercion where
import Data.Coerce (coerce)
import Network.HTTP.Client (Manager)
import Semiont.Http (HttpClient)
unchecked :: Manager -> HttpClient
unchecked = coerce
