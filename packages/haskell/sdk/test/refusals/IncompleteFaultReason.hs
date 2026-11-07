module IncompleteFaultReason where
import Semiont.Bus (FaultReason(..))

missing :: FaultReason -> Bool
missing Lacks = True
