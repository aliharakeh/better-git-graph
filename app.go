package main

import (
	"context"
	"fmt"
	"strings"
	"time"

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

func (a *App) GetRemote(path string) (*RemoteInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("enter a repository path")
	}
	root, err := gitRoot(path)
	if err != nil {
		return nil, err
	}
	info, err := listRemote(root)
	if err != nil {
		return nil, err
	}
	return &info, nil
}

func (a *App) SaveRemoteToken(host string, token string) error {
	return saveToken(host, token)
}

func (a *App) FetchRemote(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("enter a repository path")
	}
	root, err := gitRoot(path)
	if err != nil {
		return err
	}
	info, err := listRemote(root)
	if err != nil {
		return err
	}
	tokens, _ := loadTokens()
	return fetchRemote(root, info, tokens[info.Host])
}

func (a *App) LoadRepo(path string, branches []string, since string, until string) (*RepoGraph, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("enter a repository path")
	}
	from, err := parseISO(since)
	if err != nil {
		return nil, fmt.Errorf("invalid since: %w", err)
	}
	to, err := parseISO(until)
	if err != nil {
		return nil, fmt.Errorf("invalid until: %w", err)
	}
	if branches == nil && from.IsZero() && to.IsZero() {
		return LoadGraph(path)
	}
	return loadGraphAt(path, branches, from, to)
}

func parseISO(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, s)
	}
	return t, err
}
