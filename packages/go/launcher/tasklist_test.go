package launcher

import "testing"

// tasklist's CSV row names the image first and the pid second. The name is
// what comes before .exe, and a process that is not there has no name.
func TestTasklistImageNamesAProcess(t *testing.T) {
	for _, c := range []struct{ why, out, pid, want string }{
		{"a row for the process", "\"gh.exe\",\"4242\",\"Console\",\"1\",\"10,000 K\"\r\n", "4242", "gh"},
		{"a system process, which has no .exe", "\"System\",\"4\",\"Services\",\"0\",\"148 K\"\r\n", "4", "System"},
		{"an image with a comma in its memory column and spaces in its name", "\"Docker Desktop.exe\",\"900\",\"Console\",\"1\",\"1,204,332 K\"\r\n", "900", "Docker Desktop"},
		{"a row for another process", "\"node.exe\",\"77\",\"Console\",\"1\",\"10 K\"\r\n", "78", ""},
		{"the sentence tasklist prints when nothing matches", "INFO: No tasks are running which match the specified criteria.\r\n", "4242", ""},
		{"nothing at all", "", "4242", ""},
	} {
		if got := tasklistImage(c.out, c.pid); got != c.want {
			t.Errorf("%s: tasklistImage = %q, want %q", c.why, got, c.want)
		}
	}
}
