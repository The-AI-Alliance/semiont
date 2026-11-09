include module type of struct
  include Client_core
end

module Frame = Frame
module Browse = Browse
module Mark = Mark
module Bind = Namespace_methods.Bind
module Gather = Gather
module Match = Match
module Yield = Yield
module Beckon = Namespace_methods.Beckon
module Job = Job
module Auth = Auth
module System = System

val wire : t -> Bus.t
