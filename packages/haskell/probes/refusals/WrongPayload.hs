module WrongPayload where
import ProbeTypes
value :: IO Int
value = receive NoScope GlobalProbe
