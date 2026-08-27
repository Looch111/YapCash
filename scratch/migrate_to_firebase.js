const { syncAccountToFirestore, fetchAccountsFromFirestore } = require("../lib/firebaseClient");

const INITIAL_14_ACCOUNTS = [
  {
    "accountId": "account_1",
    "email": "loochmane4@gmail.com",
    "refreshToken": "b43e6qrmbri5",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiIzNmMwZWFkNi0yMDE2LTQzM2YtOWNmMC0yNmJkZTljMzE1NjAiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MDk2LCJpYXQiOjE3ODc2ODA0OTYsImVtYWlsIjoibG9vY2htYW5lNEBnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiYXZhdGFyX3VybCI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0pINjFxckFqel9Mdl91Z3dseG9rcWg3RFh6X3ZsS194REV6X1lOOWRQd1BJNEpsQT1zOTYtYyIsImNvdW50cnkiOiJVUyIsImN1c3RvbV9ub3RlIjoiVGVzdGluZyBlZGl0YWJsZSBmaWVsZHMiLCJlbWFpbCI6Imxvb2NobWFuZTRAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsImZ1bGxfbmFtZSI6Ikxvb2NoIE1hbmUiLCJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJuYW1lIjoiTG9vY2ggTWFuZSIsIm9jY3VwYXRpb24iOiJTZW5pb3IgRGV2ZWxvcGVyIiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJwaWN0dXJlIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jSkg2MXFyQWp6X0x2X3Vnd2x4b2txaDdEWHpfdmxLX3hERXpfWU45ZFB3UEk0SmxBPXM5Ni1jIiwicHJlZmVycmVkX2FpIjoiY2xhdWRlIiwicHJlZmVycmVkX2dpZnRfY2FyZCI6ImFtYXpvbiIsInByb3ZpZGVyX2lkIjoiMTE3Mjg0NjkwODk2NzgzOTY4NDUwIiwicmV3YXJkX2NvdW50cnkiOiJVUyIsInN1YiI6IjExNzI4NDY5MDg5Njc4Mzk2ODQ1MCJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6Im9hdXRoIiwidGltZXN0YW1wIjoxNzg3Njc5ODkwfV0sInNlc3Npb25faWQiOiI1NWFlYmRkZi1lMGMwLTRiYjktOWMzYi0xMTkwY2RhNmMxNGYiLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.OhVDBwIZnU-cJMkjsC2oHFZIoUPgMJK0tHdiy8JYCikHk1hcguALSTExMiNIO9VY11kjZgQT76yiEYhdLU2nww",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@38.154.185.97:6370",
    "preferredBrand": "apple",
    "userId": "36c0ead6-2016-433f-9cf0-26bde9c31560"
  },
  {
    "accountId": "account_2",
    "email": "manelooch38@gmail.com",
    "refreshToken": "v10t3x4u26f6",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJiMDFlNTA3Yi05NTRiLTRlYWYtOGMyZS0yNDc3ODkwN2IxZTUiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MDk3LCJpYXQiOjE3ODc2ODA0OTcsImVtYWlsIjoibWFuZWxvb2NoMzhAZ21haWwuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJnb29nbGUiLCJwcm92aWRlcnMiOlsiZ29vZ2xlIl19LCJ1c2VyX21ldGFkYXRhIjp7ImF2YXRhcl91cmwiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BQ2c4b2NKTVBDX2tldTlyY3prM00wdkxyZEF6bVFRbWhhblpza09XN2wzcExzYVlhTFk9czk2LWMiLCJlbWFpbCI6Im1hbmVsb29jaDM4QGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJNYW5lIExvb2NoIiwiaXNzIjoiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tIiwibmFtZSI6Ik1hbmUgTG9vY2giLCJwaG9uZV92ZXJpZmllZCI6ZmFsc2UsInBpY3R1cmUiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BQ2c4b2NKTVBDX2tldTlyY3prM00wdkxyZEF6bVFRbWhhblpza09XN2wzcExzYVlhTFk9czk2LWMiLCJwcm92aWRlcl9pZCI6IjExMTA2NTEyMjI4NzAwMzY1NDQxNSIsInN1YiI6IjExMTA2NTEyMjI4NzAwMzY1NDQxNSJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6Im9hdXRoIiwidGltZXN0YW1wIjoxNzg3NjgwMDU2fV0sInNlc3Npb25faWQiOiJmOGYzMmE0OS0yNmUyLTQ5OTctYjgyZS1mNmI0ZmNjOGVlZWEiLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.9y4pT9_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@198.23.243.226:6361",
    "preferredBrand": "apple",
    "userId": "b01e507b-954b-4eaf-8c2e-24778907b1e5"
  },
  {
    "accountId": "account_3",
    "email": "manelooch4@gmail.com",
    "refreshToken": "9tfsrfjvevvu",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJmMDVhMGRhNi04MzkzLTQxNDYtYWJkMS1jYmJmMDEwZTMyNTciLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MDk4LCJpYXQiOjE3ODc2ODA0OTgsImVtYWlsIjoibWFuZWxvb2NoNEBnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiYXZhdGFyX3VybCI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0k4X3BmdExiZEQ0OHFhS2JqTThGSmM3dnlWOTJzYVJraUN6cm1jSkdYcFlBPUZzOTYtYyIsImVtYWlsIjoibWFuZWxvb2NoNEBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiTWFuZSBMb29jaCIsImlzcyI6Imh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbSIsIm5hbWUiOiJNYW5lIExvb2NoIiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJwaWN0dXJlIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jSThfcGZ0TGJkRDQ4cWFLYmpNOFZKYzd2eVY5MnNhUmtpQ3pybWNKR1hwWUE9RnM5Ni1jIiwicHJvdmlkZXJfaWQiOiIxMTY4MTM5MTA1OTk3MDgwMTI2NDEiLCJzdWIiOiIxMTY4MTM5MTA1OTk3MDgwMTI2NDEifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDEyMn1dLCJzZXNzaW9uX2lkIjoiMWNmMDA5NDktNmI1OS00NDIxLWE0NWYtODhhMzc0YjZlMjA5IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.5iK81O5H8x0w14x8gQ8p",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@154.36.110.199:6853",
    "preferredBrand": "apple",
    "userId": "f05a0da6-8393-4146-abd1-cbbf010e3257"
  },
  {
    "accountId": "account_4",
    "email": "angelavictor461@gmail.com",
    "refreshToken": "v1q8t5l3d1x7",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI2N2M2OGJjOS1lMmMxLTQyODUtOTg4ZC0xMDFjMTg4YWIzNWUiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MDk5LCJpYXQiOjE3ODc2ODA0OTksImVtYWlsIjoiYW5nZWxhdmljdG9yNDYxQGdtYWlsLmNvbSIsInBob25lIjoiIiwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiZ29vZ2xlIiwicHJvdmlkZXJzIjpbImdvb2dsZSJdfSwidXNlcl9tZXRhZGF0YSI6eyJhdmF0YXJfdXJsIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jSTktVjhXTlV2d00zc0t3aTVvWkZ1VHpJUk9VOUxLSlc2OWdDY1Roc3Jndnc9czk2LWMiLCJlbWFpbCI6ImFuZ2VsYXZpY3RvcjQ2MUBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiQW5nZWxhIFZpY3RvciIsImlzcyI6Imh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbSIsIm5hbWUiOiJBbmdlbGEgVmljdG9yIiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJwaWN0dXJlIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jSTktVjhXTlV2d00zc0t3aTVvWkZ1VHpJUk9VOUxLSlc2OWdDY1Roc3Jndnc9czk2LWMiLCJwcm92aWRlcl9pZCI6IjExMzc0ODAzMzc3NzMxOTU2MDA3OCIsInN1YiI6IjExMzc0ODAzMzc3NzMxOTU2MDA3OCJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6Im9hdXRoIiwidGltZXN0YW1wIjoxNzg3NjgwMTg1fV0sInNlc3Npb25faWQiOiJhM2RiN2FiNS1lZWUzLTQ0YmMtODlhZi02MjliOGVlMGQxMDIiLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.8kY4P0_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@45.38.107.97:6014",
    "preferredBrand": "apple",
    "userId": "67c68bc9-e2c1-4285-988d-101c188ab35e"
  },
  {
    "accountId": "account_5",
    "email": "kadiri25.emmanuel@edouniversity.edu.ng",
    "refreshToken": "7k9x2l4v6n1m",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI1N2Y4OWFiYy0xMjM0LTU2NzgtOTAxMi0zNDU2Nzg5MDEyMzQiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAwLCJpYXQiOjE3ODc2ODA1MDAsImVtYWlsIjoia2FkaXJpMjUuZW1tYW51ZWxAZWRvdW5pdmVyc2l0eS5lZHUubmciLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiZW1haWwiOiJrYWRpcmkyNS5lbW1hbnVlbEBlZG91bml2ZXJzaXR5LmVkdS5uZyIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJFbW1hbnVlbCBLYWRpcmkiLCJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJuYW1lIjoiRW1tYW51ZWwgS2FkaXJpIiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlfSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDIxNX1dLCJzZXNzaW9uX2lkIjoiNTdmODlhYmMtMTIzNC01Njc4LTkwMTItMzQ1Njc4OTAxMjM0IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.9kY4P0_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@198.105.121.200:6462",
    "preferredBrand": "apple",
    "userId": "57f89abc-1234-5678-9012-345678901234"
  },
  {
    "accountId": "account_6",
    "email": "ogbu25.chinedu@edouniversity.edu.ng",
    "refreshToken": "m3v8t2n1k7x4",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI2OGY5MGFiYy0yMzQ1LTY3ODktMDEyMy00NTY3ODkwMTIzNDUiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAwLCJpYXQiOjE3ODc2ODA1MDAsImVtYWlsIjoib2didTI1LmNoaW5lZHVAZWRvdW5pdmVyc2l0eS5lZHUubmciLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiZW1haWwiOiJvZ2J1MjUuY2hpbmVkdUBlZG91bml2ZXJzaXR5LmVkdS5uZyIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJDaGluZWR1IE9nYnUiLCJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJuYW1lIjoiQ2hpbmVkdSBPZ2J1IiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlfSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDI0NX1dLCJzZXNzaW9uX2lkIjoiNjhmOTBhYmMtMjM0NS02Nzg5LTAxMjMtNDU2Nzg5MDEyMzQ1IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.9kY4P0_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@38.154.185.97:6370",
    "preferredBrand": "apple",
    "userId": "68f90abc-2345-6789-0123-456789012345"
  },
  {
    "accountId": "account_7",
    "email": "tomisinbalogun8@gmail.com",
    "refreshToken": "x4n1m7k2v8t3",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI3OWEwMWFiYy0zNDU2LTc4OTAtMTIzNC01Njc4OTAxMjM0NTYiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAwLCJpYXQiOjE3ODc2ODA1MDAsImVtYWlsIjoidG9taXNpbmJhbG9ndW44QGdtYWlsLmNvbSIsInBob25lIjoiIiwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiZ29vZ2xlIiwicHJvdmlkZXJzIjpbImdvb2dsZSJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbCI6InRvbWlzaW5iYWxvZ3VuOEBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiVG9taXNpbiBCYWxvZ3VuIiwiaXNzIjoiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tIiwibmFtZSI6IlRvbWlzaW4gQmFsb2d1biIsInBob25lX3ZlcmlmaWVkIjpmYWxzZX0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoib2F1dGgiLCJ0aW1lc3RhbXAiOjE3ODc2ODAyNzV9XSwic2Vzc2lvbl9pZCI6Ijc5YTAxYWJjLTM0NTYtNzg5MC0xMjM0LTU2Nzg5MDEyMzQ1NiIsImlzX2Fub255bW91cyI6ZmFsc2V9.9kY4P0_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@198.23.243.226:6361",
    "preferredBrand": "apple",
    "userId": "79a01abc-3456-7890-1234-567890123456"
  },
  {
    "accountId": "account_8",
    "email": "gamerfx919@gmail.com",
    "refreshToken": "l2v8t3n1k7x4",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI4MGIxMmFiYy00NTY3LTg5MDEtMjM0NS02Nzg5MDEyMzQ1NjciLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAwLCJpYXQiOjE3ODc2ODA1MDAsImVtYWlsIjoiZ2FtZXJmeDkxOUBnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiZW1haWwiOiJnYW1lcmZ4OTE5QGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJHYW1lciBGWCIsImlzcyI6Imh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbSIsIm5hbWUiOiJHYW1lciBGWCIsInBob25lX3ZlcmlmaWVkIjpmYWxzZX0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoib2F1dGgiLCJ0aW1lc3RhbXAiOjE3ODc2ODAzMDV9XSwic2Vzc2lvbl9pZCI6IjgwYjEyYWJjLTQ1NjctODkwMS0yMzQ1LTY3ODkwMTIzNDU2NyIsImlzX2Fub255bW91cyI6ZmFsc2V9.9kY4P0_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@154.36.110.199:6853",
    "preferredBrand": "apple",
    "userId": "80b12abc-4567-8901-2345-678901234567"
  },
  {
    "accountId": "account_9",
    "email": "uy5795519@gmail.com",
    "refreshToken": "k7x4n1m7k2v8",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI5MWMyM2FiYy01Njc4LTkwMTItMzQ1Ni03ODkwMTIzNDU2NzgiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAwLCJpYXQiOjE3ODc2ODA1MDAsImVtYWlsIjoidXk1Nzk1NTE5QGdtYWlsLmNvbSIsInBob25lIjoiIiwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiZ29vZ2xlIiwicHJvdmlkZXJzIjpbImdvb2dsZSJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbCI6InV5NTc5NTUxOUBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiVVkgNTc5NSIsImlzcyI6Imh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbSIsIm5hbWUiOiJVWSA1Nzk1IiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlfSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDMzNX1dLCJzZXNzaW9uX2lkIjoiOTFjMjNhYmMtNTY3OC05MDEyLTM0NTYtNzg5MDEyMzQ1Njc4IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.9kY4P0_hVdM2r5cO0d4Lq527gE6aFqX-Q9kYdY7o1F-gQ",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@45.38.107.97:6014",
    "preferredBrand": "apple",
    "userId": "91c23abc-5678-9012-3456-789012345678"
  },
  {
    "accountId": "account_10",
    "email": "frostmax859@gmail.com",
    "refreshToken": "w8y2d7a4p9n3",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJiMzRhMDkyNy0zY2UzLTQxNzMtOWY1MC0zNzAzY2FlMGZlYzMiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAxLCJpYXQiOjE3ODc2ODA1MDEsImVtYWlsIjoiZnJvc3RtYXg4NTlAZ21haWwuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJnb29nbGUiLCJwcm92aWRlcnMiOlsiZ29vZ2xlIl19LCJ1c2VyX21ldGFkYXRhIjp7ImF2YXRhcl91cmwiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BQ2c4b2NKd0RSRDRKOTlXbE9Vckw3T013OEI1eFB5cFB1QkFYYlU2TktnTHNpaXg9czk2LWMiLCJlbWFpbCI6ImZyb3N0bWF4ODU5QGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJGcm9zdCBNYXgiLCJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJuYW1lIjoiRnJvc3QgTWF4IiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJwaWN0dXJlIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jSndEUkQ0Sjk5V2xPVXJMN09NdzhCNXhQeXBQdUJBWGJVMk5LZ0xzaWl4PXM5Ni1jIiwicHJvdmlkZXJfaWQiOiIxMTcyOTg5ODE1MTE1NjY0Mjg5OTUiLCJzdWIiOiIxMTcyOTg5ODE1MTE1NjY0Mjg5OTUifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDI5NX1dLCJzZXNzaW9uX2lkIjoiNTdhZTY3ZDQtZjRlNy00YmU4LTk2N2YtMjQzNzdiMWNhYTA1IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.T5J7Y158-j-N6J8R9T0U1V2W3X4Y5Z6A7B8C9D0E",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@198.23.243.226:6361",
    "preferredBrand": "apple",
    "userId": "b34a0927-3ce3-4173-9f50-3703cae0fec3"
  },
  {
    "accountId": "account_11",
    "email": "fednardpro@gmail.com",
    "refreshToken": "6kdxekgax5e2",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJmMWI1YWQwZS0wNDQyLTQ2MjEtOTcxYi05OWI0ZDdiZDdiMjAiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAxLCJpYXQiOjE3ODc2ODA1MDEsImVtYWlsIjoiZmVkbmFyZHByb0BnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiYXZhdGFyX3VybCI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0l5M3RKbVdMR3dDeFV2Q2tMcE50UE9QMG92c2JCQU1hZWh1QnU0Z3lLd2FQUno4dz1zOTYtYyIsImVtYWlsIjoiZmVkbmFyZHByb0BnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiRmVkbmFyZCBQcm8iLCJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJuYW1lIjoiRmVkbmFyZCBQcm8iLCJwaG9uZV92ZXJpZmllZCI6ZmFsc2UsInBpY3R1cmUiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BQ2c4b2NJeTN0Sm1XTEd3Q3hVdkNrTHBOdFBPUDBvdnNiQkFNYWVodUJ1NGd5S3dhUFJ6OHc9czk2LWMiLCJwcm92aWRlcl9pZCI6IjExMzA3NTkyMDgxNjQxMTUwOTM0NyIsInN1YiI6IjExMzA3NTkyMDgxNjQxMTUwOTM0NyJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6Im9hdXRoIiwidGltZXN0YW1wIjoxNzg3NjgwMzMxfV0sInNlc3Npb25faWQiOiJjY2U5NGNjZi0yMGFiLTQ0YTctYjk0OC1mZTUxNjNhNWEwNjUiLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.vhrgqjjJepR0JK3Dc5QDOb7vi_1lg2yD-o-5UHfV5OjJS9uJYY6O8kk24veFxqqmnYLSeEnXlNF0CsEbmYAlSg",
    "proxy": "http://bmrtynfq:cd2hv07lt0yr@38.154.185.97:6370",
    "preferredBrand": "apple",
    "userId": "f1b5ad0e-0442-4621-971b-99b4d7bd7b20"
  },
  {
    "accountId": "account_12",
    "email": "fednarddigital@gmail.com",
    "refreshToken": "m7xf4m4vwswu",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJlMzJmYzJlZS0wYWYzLTQ2OGQtOTY1My00Y2M0NjllOTJkYzYiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAyLCJpYXQiOjE3ODc2ODA1MDIsImVtYWlsIjoiZmVkbmFyZGRpZ2l0YWxAZ21haWwuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJnb29nbGUiLCJwcm92aWRlcnMiOlsiZ29vZ2xlIl19LCJ1c2VyX21ldGFkYXRhIjp7ImF2YXRhcl91cmwiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BQ2c4b2NJYnlqUWxJZ2dWOVJHclRRMGJ1LXFrcFRIRWM0RkplUkY0SjV3aGVSekFkOXlMdHJnPXM5Ni1jIiwiZW1haWwiOiJmZWRuYXJkZGlnaXRhbEBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiRGlnaXRhbCBGZWRuYXJkIiwiaXNzIjoiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tIiwibmFtZSI6IkRpZ2l0YWwgRmVkbmFyZCIsInBob25lX3ZlcmlmaWVkIjpmYWxzZSwicGljdHVyZSI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0llYnlqUWxJZ2dWOVJHclRRMGJ1LXFrcFRIRWM0RkplUkY0SjV3aGVSekFkOXlMdHJnPXM5Ni1jIiwicHJvdmlkZXJfaWQiOiIxMDQxNzY3MzEzNDU4NTk2MjExMzEiLCJzdWIiOiIxMDQxNzY3MzEzNDU4NTk2MjExMzEifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDM3OX1dLCJzZXNzaW9uX2lkIjoiMjkwNGU3OWUtNjRhOS00N2JjLTk5ZTktMTA4M2ViYzJlMzQ5IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.bzuZY66CmVawnzNWKuCQU5RDWj1TWxW-wSudZauhKQjlOptMrehCw69gTJ4vOCkUXl8Xbwa86SizPGIGp1ijEw",
    "proxy": "http://fdkvfpmk:bsd6d7oqqn1u@31.59.20.176:6754",
    "preferredBrand": "apple",
    "userId": "e32fc2ee-0af3-468d-9653-4cc469e92dc6"
  },
  {
    "accountId": "account_13",
    "email": "jw169020@gmail.com",
    "refreshToken": "2mhb4lfvgpx2",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJkZGQ4ZDdhZC03NmViLTQ4N2MtYjYyNi05YWNhY2ZjMGYwNzQiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAyLCJpYXQiOjE3ODc2ODA1MDIsImVtYWlsIjoiancxNjkwMjBAZ21haWwuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJnb29nbGUiLCJwcm92aWRlcnMiOlsiZ29vZ2xlIl19LCJ1c2VyX21ldGFkYXRhIjp7ImF2YXRhcl91cmwiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS9BQ2c4b2NJM0NiX2NvVnY3NE1uV1FtZkFEdmdHN0dlc0dDc2JzU3RwWmJsWng1N0FyWjFQb0E9czk2LWMiLCJlbWFpbCI6Imp3MTY5MDIwQGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJKYW1lcyBXYWxrZXIiLCJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJuYW1lIjoiSmFtZXMgV2Fsa2VyIiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJwaWN0dXJlIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jSTNDYl9jb1Z2NzRNbldRbWZBRHZnRzdHZXNHQ3Nic1N0cFpibFp4NTdBcloxUG9BPXM5Ni1jIiwicHJvdmlkZXJfaWQiOiIxMTQ1NjcwNjEzNzE1MzA5OTY5MDIiLCJzdWIiOiIxMTQ1NjcwNjEzNzE1MzA5OTY5MDIifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc4NzY4MDQxOX1dLCJzZXNzaW9uX2lkIjoiOTM1YTEwMTktMTM3MS00ODAxLWJmODctNDliYWRlNmE2YWM5IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.Uvv46HyzdgspnCuZOBFDfNfMKUaGy6baYxlm0a5q653hinq-UQzmKDBufn1Me85_gXEvk2r_6skqtIhY8Nzxqg",
    "proxy": "http://fdkvfpmk:bsd6d7oqqn1u@45.38.107.97:6014",
    "preferredBrand": "apple",
    "userId": "ddd8d7ad-76eb-447c-b626-9acacfc0f074"
  },
  {
    "accountId": "account_14",
    "email": "saadkhan89570@gmail.com",
    "refreshToken": "eh22npriejnh",
    "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZhNzU0YWRjLWM1ODctNGI2NS1hMDg5LTYzYmY4ODY5ZDQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2dpZG95cmJ2bmZmY3dienp3ZXFiLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI5OTJkMzhhNy1jZTIzLTRhNjUtYjdlYi03NTMzYzZlMDllOGEiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg3Njg0MTAzLCJpYXQiOjE3ODc2ODA1MDMsImVtYWlsIjoic2FhZGtoYW44OTU3MEBnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6Imdvb2dsZSIsInByb3ZpZGVycyI6WyJnb29nbGUiXX0sInVzZXJfbWV0YWRhdGEiOnsiYXZhdGFyX3VybCI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0t0dGp1em1Ka3NSLU5GWmFfem5aWUpQSzMzUzN1R1hhX0pFRWhnN0hpZXYyNkloQT1zOTYtYyIsImVtYWlsIjoic2FhZGtoYW44OTU3MEBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiU2FhZCBLaGFuIiwiaXNzIjoiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tIiwibmFtZSI6IlNhYWQgS2hhbiIsInBob25lX3ZlcmlmaWVkIjpmYWxzZSwicGljdHVyZSI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0t0dGp1em1Ka3NSLU5GWmFfem5aWUpQSzMzUzN1R1hhX0pFRWhnN0hpZXYyNkloQT1zOTYtYyIsInByb3ZpZGVyX2lkIjoiMTE0NzQ5ODQ5ODA1Mzg4NzgwOTE5Iiwic3ViIjoiMTE0NzQ5ODQ5ODA1Mzg4NzgwOTE5In0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoib2F1dGgiLCJ0aW1lc3RhbXAiOjE3ODc2ODA0NjV9XSwic2Vzc2lvbl9pZCI6Ijg3NWVjZDE2LTkwZjEtNDk1MS1iNmEzLTBmMzRkNzE0NTAyMCIsImlzX2Fub255bW91cyI6ZmFsc2V9.iMzk4NKL_eVd7L-7FLpTurdIiG_pKVbN-F2gBbIpf780Y-Sw-1UR0RtyxD5vLxBoEQERPowASsQWHae8dZThnw",
    "proxy": "http://fdkvfpmk:bsd6d7oqqn1u@198.105.121.200:6462",
    "preferredBrand": "apple",
    "userId": "992d38a7-ce23-4a65-b7eb-7533c6e09e8a"
  }
];

(async () => {
  console.log("=======================================================");
  console.log(" 🚀 YAPCASH FIREBASE FIRESTORE 14-ACCOUNT SEEDING");
  console.log("=======================================================\n");

  const accounts = [...INITIAL_14_ACCOUNTS];

  // Sort accounts numerically: account_1, account_2, ... account_14
  accounts.sort((a, b) => {
    const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
    const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
    return numA - numB;
  });

  console.log(`📦 Seeding ${accounts.length} accounts to Firebase Firestore...`);

  let successCount = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const orderNum = parseInt((acc.accountId || "").replace(/\D/g, ""), 10) || (i + 1);
    acc.order = orderNum;
    console.log(`⏳ [Order: ${orderNum}] Syncing ${acc.accountId} (${acc.email})...`);
    const ok = await syncAccountToFirestore(acc);
    if (ok) {
      console.log(`✅ [Firestore] ${acc.accountId} (Order: ${orderNum}) saved to Firebase Cloud!`);
      successCount++;
    } else {
      console.log(`⚠️ [Firestore] ${acc.accountId} sync failed`);
    }
  }

  console.log("\n🔍 Verifying cloud accounts in Firebase Firestore...");
  const cloudAccounts = await fetchAccountsFromFirestore();
  console.log(`📊 Cloud Accounts Hydrated: ${cloudAccounts.length}/14 Accounts in Firebase Firestore`);

  console.log("\n=======================================================");
  console.log(" 🏆 MIGRATION COMPLETE: All 14 accounts in Firebase!");
  console.log("=======================================================");
  process.exit(0);
})();
