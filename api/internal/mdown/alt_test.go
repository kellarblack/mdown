package mdown

import "testing"

func TestPickAlternative(t *testing.T) {
	dior := []altEntry{
		{ID: "oorVWW9ywG0", Title: "POP SMOKE - DIOR (OFFICIAL VIDEO)", Channel: "POP SMOKE", Duration: 173},
		{ID: "goYgHnsQdtY", Title: "Pop Smoke - Dior (Official Audio)", Channel: "POP SMOKE", Duration: 217},
		{ID: "9dPiZwLnAMY", Title: "POP SMOKE - DIOR (Official Lyric Video)", Channel: "POP SMOKE", Duration: 217},
		{ID: "o95tbaivZ2o", Title: "Pop Smoke - Dior (Lyrics)", Channel: "7clouds", Duration: 217},
		{ID: "sDupWI9-_Es", Title: "Pop Smoke Greatest Hits Full Album", Channel: "Always Hits", Duration: 1621},
	}
	if got := pickAlternative("Dior", "Pop Smoke", 216.4, dior); got == nil || got.ID != "goYgHnsQdtY" {
		t.Fatalf("dior: got %+v", got)
	}
	// the feature credit is not required in the YouTube title
	night := []altEntry{
		{ID: "aaaaaaaaaaa", Title: "For The Night (Sped Up)", Channel: "edits", Duration: 150},
		{ID: "bbbbbbbbbbb", Title: "Pop Smoke - For The Night (Audio) ft. Lil Baby, DaBaby", Channel: "POP SMOKE", Duration: 191},
	}
	if got := pickAlternative("For The Night (feat. Lil Baby & DaBaby)", "Pop Smoke", 190, night); got == nil || got.ID != "bbbbbbbbbbb" {
		t.Fatalf("night: got %+v", got)
	}
	// wrong length, a remix, or a different title: no offer at all
	bad := []altEntry{
		{ID: "ccccccccccc", Title: "Dior (Remix)", Channel: "x", Duration: 216},
		{ID: "ddddddddddd", Title: "Pop Smoke - Dior", Channel: "POP SMOKE", Duration: 300},
		{ID: "eeeeeeeeeee", Title: "Welcome To The Party", Channel: "POP SMOKE", Duration: 216},
		{ID: "bad id", Title: "Dior", Channel: "POP SMOKE", Duration: 216},
	}
	if got := pickAlternative("Dior", "Pop Smoke", 216, bad); got != nil {
		t.Fatalf("bad: got %+v", got)
	}
	if isSoundCloud("https://youtube.com/watch?v=x") || !isSoundCloud("https://m.soundcloud.com/a/b") {
		t.Fatal("isSoundCloud")
	}
}
