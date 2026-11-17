// Command mdown-api is the mdown.cc download API.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kelllar/mdown/api/internal/mdown"
	"golang.org/x/net/netutil"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	cfg, err := mdown.ConfigFromEnv(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(2)
	}
	srv, err := mdown.NewServer(&cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot start: %v\n", err)
		os.Exit(1)
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot bind %s - %v\n", addr, err)
		os.Exit(1)
	}
	// more sockets than this a small box cannot serve; the kernel queue holds the rest
	ln = netutil.LimitListener(ln, 256)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	srv.Background(ctx)

	httpServer := &http.Server{
		Handler: srv.Handler(),
		// a client that sends headers and then nothing must not hold a socket
		ReadHeaderTimeout: 20 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 * 1024,
		ErrorLog:          log.New(os.Stderr, "http: ", 0),
	}
	log.Printf("listening on %s | max %dp, %ds, %d concurrent, %d queued, %dMB output, streaming %v",
		addr, cfg.MaxHeight, cfg.MaxDuration, cfg.MaxConcurrent, cfg.MaxQueue, cfg.MaxOutputBytes/mdown.MB, cfg.Streaming)
	log.Printf("cors origins: %s", strings.Join(cfg.CORSOrigins, ", "))
	if cfg.APIKey != "" {
		log.Printf("api key required")
	}

	go func() {
		<-ctx.Done()
		log.Printf("shutting down")
		srv.Shutdown()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("serve: %v", err)
		os.Exit(1)
	}
}
