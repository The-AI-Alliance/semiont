module MissingScope where
import ProbeTypes
value :: IO Int
value = receive NoScope ScopedProbe
