external try_exclusive : Unix.file_descr -> bool = "semiont_probe_try_flock"
external unlock : Unix.file_descr -> unit = "semiont_probe_unlock"
