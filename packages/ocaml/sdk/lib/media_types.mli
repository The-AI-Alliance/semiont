type text_source = Decode | Pdf_text_layer | No_text

val base : string -> string
val clone_format : string -> string
val text_source : string -> text_source
val yields_geometry : string -> bool
val derives_text : string -> bool
val storage_file_name : name:string -> format:string -> string
