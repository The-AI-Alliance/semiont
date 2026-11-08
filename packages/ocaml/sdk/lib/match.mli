include module type of Namespace_methods.Match

val resources :
  Client_core.t ->
  [ `MatchResourcesRequest ] Bus_registry.component Bus_registry.decoded ->
  Client_core.query

val search :
  Client_core.t ->
  [ `MatchSearchRequest ] Bus_registry.component Bus_registry.decoded ->
  ( [ `MatchSearchResult ] Bus_registry.component Bus_registry.decoded,
    Client_core.error )
  result
  Running.t
