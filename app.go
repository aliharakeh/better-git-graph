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

func (a *App) ListBranches(path string) ([]BranchInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("enter a repository path")
	}
	return ListBranches(path)
}

func (a *App) LoadRepo(path string, branches []string) (*RepoGraph, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("enter a repository path")
	}
	if branches == nil {
		return LoadGraph(path)
	}
	return loadGraph(path, branches)
}
