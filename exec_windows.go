//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW tells Windows to run the process without allocating a
// console window. Combined with HideWindow, this stops a console from
// flashing when a GUI app spawns console-subsystem executables like git.exe.
const createNoWindow = 0x08000000

// hideWindow configures a command so it runs silently without opening a
// console window on Windows.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}
