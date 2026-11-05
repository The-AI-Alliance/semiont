// refused: inaccessible due to 'internal' protection level
import Semiont

let forged = Channel<BeckonFocusEvent>(name: "unregistered", stamps: [])
