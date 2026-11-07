module ClientRecordUpdate where
import qualified Semiont.Client as Client
import qualified Semiont.Bus as Bus

replace :: Client.Client -> Bus.Bus -> Client.Client
replace client wire = client { Client.wire = wire }
