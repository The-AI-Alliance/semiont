module NetworkInSimulation where
import Control.Monad.IOSim (IOSim)
import Network.HTTP.Client (Manager, Request, Response, BodyReader, responseOpen)
value :: Manager -> Request -> IOSim scope (Response BodyReader)
value manager request = responseOpen request manager
