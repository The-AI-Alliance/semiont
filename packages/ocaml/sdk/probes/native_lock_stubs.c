#include <errno.h>
#include <sys/file.h>
#include <caml/mlvalues.h>
#include <caml/unixsupport.h>

CAMLprim value semiont_probe_try_flock(value descriptor) {
  if (flock(Int_val(descriptor), LOCK_EX | LOCK_NB) == 0) return Val_true;
  if (errno == EWOULDBLOCK || errno == EAGAIN) return Val_false;
  uerror("flock", Nothing);
}

CAMLprim value semiont_probe_unlock(value descriptor) {
  if (flock(Int_val(descriptor), LOCK_UN) != 0) uerror("flock", Nothing);
  return Val_unit;
}
