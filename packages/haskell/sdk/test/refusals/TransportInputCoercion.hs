module TransportInputCoercion where
import Data.Coerce (coerce)
import Semiont.Transport (Transport, TransportInput)
wrong :: Transport -> TransportInput
wrong = coerce
