package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// ─── Pod Shell (WebSocket exec) ──────────────────────────────────────

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type wsTerminal struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (t *wsTerminal) Read(p []byte) (int, error) {
	_, msg, err := t.conn.ReadMessage()
	if err != nil {
		return 0, err
	}
	return copy(p, msg), nil
}

func (t *wsTerminal) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(p), t.conn.WriteMessage(websocket.TextMessage, p)
}

func apiExec(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("pod")
	ownerKind, ownerName := resolvePodOwner(ns, name)
	if !requireAdminOrJIT(w, r, ns, ownerKind, ownerName) { return }
	container := r.URL.Query().Get("container")
	if ns == "" || name == "" {
		http.Error(w, "namespace and pod required", 400)
		return
	}
	if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
		auditRecord(sd.Email, sd.Role, "pod.exec", fmt.Sprintf("Pod %s/%s", ns, name), "container: "+container, clientIP(r))
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("websocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(30 * time.Minute))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(30 * time.Minute))
		return nil
	})

	cmd := []string{"/bin/sh", "-c", "TERM=xterm exec sh"}

	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(name).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   cmd,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec)

	exec, err := remotecommand.NewSPDYExecutor(restCfg, "POST", req.URL())
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\nError: %v\r\n", err)))
		return
	}

	term := &wsTerminal{conn: conn}
	err = exec.StreamWithContext(context.Background(), remotecommand.StreamOptions{
		Stdin:  term,
		Stdout: term,
		Stderr: term,
		Tty:    true,
	})
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\nSession ended: %v\r\n", err)))
	}
}
