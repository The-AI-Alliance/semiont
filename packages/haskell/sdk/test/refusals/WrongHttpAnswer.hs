module WrongHttpAnswer where
import Semiont.Gateway (GatewayOperations, healthCheck)
import Semiont.Types (UserResponse)
wrong :: GatewayOperations -> IO UserResponse
wrong = healthCheck
