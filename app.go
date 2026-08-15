package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) SelectRepo() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select a Git repository",
	})
}

func (a *App) LoadRepo(path string) (*RepoGraph, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("enter a repository path")
	}
	return LoadGraph(path)
}
