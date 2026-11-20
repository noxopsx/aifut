// Generado por datos_live.mjs el 20/11/2026, 10:16:56 a.m..
// Fuente de datos: ESPN (calendario, tablas, forma y sede).
// Probabilidades y salidas: motor propio de OX V1.0.
// No edites este archivo a mano; ejecuta: node datos_live.mjs
// Backtest walk-forward propio; no son datos de FutbolData Pro.
export const VALIDATION = {
  "version": "1.0",
  "engine": "motor-nox-v1",
  "engineVersion": "1.0",
  "method": "walk-forward",
  "holdout": 0.3,
  "generatedAt": "2026-11-20T16:16:46.793Z",
  "minTeamMatches": 4,
  "minLeagueMatches": 20,
  "sample": {
    "matches": 1582,
    "skipped": 124,
    "leagues": 12,
    "from": "2026-04-19T00:45Z",
    "to": "2026-11-20T03:00Z",
    "events": 5678
  },
  "markets": [
    {
      "id": "1x2",
      "label": "1X2",
      "kind": "multi"
    },
    {
      "id": "btts",
      "label": "Ambos anotan",
      "kind": "binary"
    },
    {
      "id": "over15",
      "label": "Más de 1.5",
      "kind": "binary"
    },
    {
      "id": "over25",
      "label": "Más de 2.5",
      "kind": "binary"
    },
    {
      "id": "over35",
      "label": "Más de 3.5",
      "kind": "binary"
    }
  ],
  "overall": {
    "n": 1582,
    "markets": {
      "1x2": {
        "n": 1582,
        "brier": 0.6111609447170462,
        "baseline": 0.6407921115484998,
        "skill": 0.046241466299965395,
        "logLoss": 1.0202184294097287,
        "logLossBaseline": 1.0607166234271341,
        "logLossSkill": 0.03818003142682658
      },
      "btts": {
        "n": 1582,
        "brier": 0.24608545385352287,
        "baseline": 0.2446162236518864,
        "skill": -0.006006266386187509,
        "logLoss": 0.6854263836216956,
        "logLossBaseline": 0.6822605851474556,
        "logLossSkill": -0.0046401602894234895
      },
      "over15": {
        "n": 1582,
        "brier": 0.16665355072993907,
        "baseline": 0.1660589926658747,
        "skill": -0.0035804026901491426,
        "logLoss": 0.5141773876249752,
        "logLossBaseline": 0.5131072663049533,
        "logLossSkill": -0.002085570387120539
      },
      "over25": {
        "n": 1582,
        "brier": 0.24323670654955196,
        "baseline": 0.2422892610371704,
        "skill": -0.003910390036792499,
        "logLoss": 0.6797851427869678,
        "logLossBaseline": 0.677505935999345,
        "logLossSkill": -0.0033641133848676397
      },
      "over35": {
        "n": 1582,
        "brier": 0.21305439631155315,
        "baseline": 0.21024145484385148,
        "skill": -0.01337957573491333,
        "logLoss": 0.6177762632730058,
        "logLossBaseline": 0.6101806933293935,
        "logLossSkill": -0.01244806665738274
      }
    }
  },
  "hits": {
    "n": 1582,
    "hits": 775,
    "rate": 0.48988621997471554,
    "currentStreak": 0,
    "bestStreak": 8,
    "recent": [
      {
        "date": "2026-11-20T03:00Z",
        "leagueId": "usa.1",
        "leagueName": "MLS",
        "homeName": "Seattle Sounders FC",
        "awayName": "Real Salt Lake",
        "homeGoals": 1,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.388,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-20T00:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "São Paulo",
        "awayName": "Fluminense",
        "homeGoals": 0,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4163,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-20T00:30Z",
        "leagueId": "usa.1",
        "leagueName": "MLS",
        "homeName": "Orlando City SC",
        "awayName": "FC Cincinnati",
        "homeGoals": 1,
        "awayGoals": 3,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.3979,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-19T22:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Vitória",
        "awayName": "Red Bull Bragantino",
        "homeGoals": 2,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4763,
        "actual": "home",
        "actualLabel": "Local",
        "hit": false
      },
      {
        "date": "2026-11-19T22:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Vasco da Gama",
        "awayName": "Internacional",
        "homeGoals": 2,
        "awayGoals": 1,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4756,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-19T00:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Grêmio",
        "awayName": "Bahia",
        "homeGoals": 0,
        "awayGoals": 0,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.3783,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-19T00:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Corinthians",
        "awayName": "Botafogo",
        "homeGoals": 4,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.3764,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-18T23:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Cruzeiro",
        "awayName": "Palmeiras",
        "homeGoals": 2,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.494,
        "actual": "home",
        "actualLabel": "Local",
        "hit": false
      },
      {
        "date": "2026-11-18T23:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Flamengo",
        "awayName": "Athletico Paranaense",
        "homeGoals": 2,
        "awayGoals": 1,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.6994,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-18T23:00Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Remo",
        "awayName": "Chapecoense",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4922,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-18T22:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Coritiba",
        "awayName": "Santos",
        "homeGoals": 0,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.414,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-15T23:05Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Suchitepequez",
        "awayName": "Antigua GFC",
        "homeGoals": 1,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.5967,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-15T21:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Deportivo San Pedro",
        "awayName": "Marquense",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4203,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-15T01:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "CD Malacateco",
        "awayName": "Municipal",
        "homeGoals": 0,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.457,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-14T23:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Chapecoense",
        "awayName": "Vasco da Gama",
        "homeGoals": 0,
        "awayGoals": 2,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.5326,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-14T23:00Z",
        "leagueId": "mex.1",
        "leagueName": "Liga MX",
        "homeName": "Querétaro",
        "awayName": "Monterrey",
        "homeGoals": 0,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.3967,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-14T23:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Comunicaciones",
        "awayName": "Cobán Imperial",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4035,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-14T21:30Z",
        "leagueId": "bra.1",
        "leagueName": "Brasileirão",
        "homeName": "Mirassol",
        "awayName": "Atlético-MG",
        "homeGoals": 0,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.3622,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-14T21:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Xelajú MC",
        "awayName": "CD Guastatoya",
        "homeGoals": 4,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4854,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-12T22:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Aurora FC",
        "awayName": "Deportivo Mixco",
        "homeGoals": 0,
        "awayGoals": 1,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.3888,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": false
      },
      {
        "date": "2026-11-09T02:10Z",
        "leagueId": "mex.1",
        "leagueName": "Liga MX",
        "homeName": "León",
        "awayName": "Guadalajara",
        "homeGoals": 1,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4232,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-09T00:00Z",
        "leagueId": "mex.1",
        "leagueName": "Liga MX",
        "homeName": "Querétaro",
        "awayName": "Puebla",
        "homeGoals": 0,
        "awayGoals": 2,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4386,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": false
      },
      {
        "date": "2026-11-09T00:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Antigua GFC",
        "awayName": "CD Malacateco",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.5392,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-08T22:30Z",
        "leagueId": "arg.1",
        "leagueName": "Primera División Argentina",
        "homeName": "Central Córdoba (Santiago del Estero)",
        "awayName": "Lanús",
        "homeGoals": 1,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.5989,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-08T21:00Z",
        "leagueId": "gua.1",
        "leagueName": "Liga Nacional de Guatemala",
        "homeName": "Cobán Imperial",
        "awayName": "Xelajú MC",
        "homeGoals": 0,
        "awayGoals": 1,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.3716,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": false
      },
      {
        "date": "2026-11-08T20:00Z",
        "leagueId": "esp.1",
        "leagueName": "LaLiga",
        "homeName": "Atlético Madrid",
        "awayName": "Barcelona",
        "homeGoals": 1,
        "awayGoals": 2,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.41,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-08T19:45Z",
        "leagueId": "fra.1",
        "leagueName": "Ligue 1",
        "homeName": "Lens",
        "awayName": "Marseille",
        "homeGoals": 1,
        "awayGoals": 2,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.3913,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-08T19:45Z",
        "leagueId": "ita.1",
        "leagueName": "Serie A",
        "homeName": "Fiorentina",
        "awayName": "Juventus",
        "homeGoals": 2,
        "awayGoals": 2,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4303,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-08T19:00Z",
        "leagueId": "ned.1",
        "leagueName": "Eredivisie",
        "homeName": "FC Utrecht",
        "awayName": "NEC Nijmegen",
        "homeGoals": 2,
        "awayGoals": 3,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.388,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-08T18:30Z",
        "leagueId": "ger.1",
        "leagueName": "Bundesliga",
        "homeName": "TSG Hoffenheim",
        "awayName": "Schalke 04",
        "homeGoals": 2,
        "awayGoals": 1,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4751,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-08T17:30Z",
        "leagueId": "esp.1",
        "leagueName": "LaLiga",
        "homeName": "Celta Vigo",
        "awayName": "Levante",
        "homeGoals": 0,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4384,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-08T17:30Z",
        "leagueId": "esp.1",
        "leagueName": "LaLiga",
        "homeName": "Villarreal",
        "awayName": "Getafe",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.4841,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-08T17:00Z",
        "leagueId": "ita.1",
        "leagueName": "Serie A",
        "homeName": "Internazionale",
        "awayName": "Como",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.3954,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-08T16:30Z",
        "leagueId": "eng.1",
        "leagueName": "Premier League",
        "homeName": "Manchester United",
        "awayName": "Aston Villa",
        "homeGoals": 4,
        "awayGoals": 4,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.3932,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-08T16:30Z",
        "leagueId": "ger.1",
        "leagueName": "Bundesliga",
        "homeName": "SC Freiburg",
        "awayName": "1. FC Union Berlin",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.6535,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-08T16:15Z",
        "leagueId": "fra.1",
        "leagueName": "Ligue 1",
        "homeName": "Le Havre AC",
        "awayName": "Lorient",
        "homeGoals": 0,
        "awayGoals": 2,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.423,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-08T16:15Z",
        "leagueId": "fra.1",
        "leagueName": "Ligue 1",
        "homeName": "Angers",
        "awayName": "Nice",
        "homeGoals": 0,
        "awayGoals": 2,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4981,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      },
      {
        "date": "2026-11-08T16:15Z",
        "leagueId": "fra.1",
        "leagueName": "Ligue 1",
        "homeName": "Le Mans",
        "awayName": "AS Monaco",
        "homeGoals": 1,
        "awayGoals": 1,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4209,
        "actual": "draw",
        "actualLabel": "Empate",
        "hit": false
      },
      {
        "date": "2026-11-08T16:15Z",
        "leagueId": "fra.1",
        "leagueName": "Ligue 1",
        "homeName": "Brest",
        "awayName": "Lyon",
        "homeGoals": 2,
        "awayGoals": 0,
        "pick": "home",
        "pickLabel": "Local",
        "probability": 0.3652,
        "actual": "home",
        "actualLabel": "Local",
        "hit": true
      },
      {
        "date": "2026-11-08T15:45Z",
        "leagueId": "ned.1",
        "leagueName": "Eredivisie",
        "homeName": "SC Cambuur",
        "awayName": "PSV Eindhoven",
        "homeGoals": 2,
        "awayGoals": 5,
        "pick": "away",
        "pickLabel": "Visitante",
        "probability": 0.4814,
        "actual": "away",
        "actualLabel": "Visitante",
        "hit": true
      }
    ],
    "byLeague": [
      {
        "id": "arg.1",
        "name": "Primera División Argentina",
        "n": 238,
        "hits": 113,
        "rate": 0.47478991596638653
      },
      {
        "id": "bra.1",
        "name": "Brasileirão",
        "n": 216,
        "hits": 108,
        "rate": 0.5
      },
      {
        "id": "mex.1",
        "name": "Liga MX",
        "n": 141,
        "hits": 56,
        "rate": 0.3971631205673759
      },
      {
        "id": "esp.1",
        "name": "LaLiga",
        "n": 137,
        "hits": 70,
        "rate": 0.5109489051094891
      },
      {
        "id": "ita.1",
        "name": "Serie A",
        "n": 135,
        "hits": 74,
        "rate": 0.5481481481481482
      },
      {
        "id": "eng.1",
        "name": "Premier League",
        "n": 132,
        "hits": 61,
        "rate": 0.4621212121212121
      },
      {
        "id": "usa.1",
        "name": "MLS",
        "n": 124,
        "hits": 60,
        "rate": 0.4838709677419355
      },
      {
        "id": "gua.1",
        "name": "Liga Nacional de Guatemala",
        "n": 116,
        "hits": 59,
        "rate": 0.5086206896551724
      },
      {
        "id": "ned.1",
        "name": "Eredivisie",
        "n": 112,
        "hits": 58,
        "rate": 0.5178571428571429
      },
      {
        "id": "fra.1",
        "name": "Ligue 1",
        "n": 110,
        "hits": 57,
        "rate": 0.5181818181818182
      },
      {
        "id": "ger.1",
        "name": "Bundesliga",
        "n": 104,
        "hits": 47,
        "rate": 0.4519230769230769
      },
      {
        "id": "uefa.champions",
        "name": "UEFA Champions League",
        "n": 17,
        "hits": 12,
        "rate": 0.7058823529411765
      }
    ]
  },
  "leagues": [
    {
      "id": "arg.1",
      "name": "Primera División Argentina",
      "n": 238,
      "skipped": 0,
      "hits": 113,
      "hitRate": 0.47478991596638653,
      "markets": {
        "1x2": {
          "n": 238,
          "brier": 0.6274874511862912,
          "baseline": 0.6571718535588804,
          "skill": 0.045169923531926726,
          "logLoss": 1.0406832051152146,
          "logLossBaseline": 1.0848437378607476,
          "logLossSkill": 0.04070681445109792
        },
        "btts": {
          "n": 238,
          "brier": 0.26015925295986714,
          "baseline": 0.2547958288592865,
          "skill": -0.02104988972775801,
          "logLoss": 0.7148902462018027,
          "logLossBaseline": 0.7028541252258587,
          "logLossSkill": -0.01712463588668034
        },
        "over15": {
          "n": 238,
          "brier": 0.2213968378340491,
          "baseline": 0.21944151309021664,
          "skill": -0.008910459631348733,
          "logLoss": 0.6337397875678715,
          "logLossBaseline": 0.6309406388989075,
          "logLossSkill": -0.004436469132578003
        },
        "over25": {
          "n": 238,
          "brier": 0.2514134386019474,
          "baseline": 0.24669321846164677,
          "skill": -0.01913396796934852,
          "logLoss": 0.699651221607352,
          "logLossBaseline": 0.6871546810685699,
          "logLossSkill": -0.01818592070034253
        },
        "over35": {
          "n": 238,
          "brier": 0.14977724510217766,
          "baseline": 0.14732165757709925,
          "skill": -0.01666820456315654,
          "logLoss": 0.4786205631871434,
          "logLossBaseline": 0.4740181444597515,
          "logLossSkill": -0.0097093724811681
        }
      }
    },
    {
      "id": "bra.1",
      "name": "Brasileirão",
      "n": 216,
      "skipped": 0,
      "hits": 108,
      "hitRate": 0.5,
      "markets": {
        "1x2": {
          "n": 216,
          "brier": 0.6061225869781673,
          "baseline": 0.6282943480201957,
          "skill": 0.0352888118632505,
          "logLoss": 1.011609634660971,
          "logLossBaseline": 1.0444891209473612,
          "logLossSkill": 0.03147901268379716
        },
        "btts": {
          "n": 216,
          "brier": 0.25386622598448055,
          "baseline": 0.2478460237227977,
          "skill": -0.02429009015862249,
          "logLoss": 0.7009033024178852,
          "logLossBaseline": 0.6888380695550026,
          "logLossSkill": -0.01751533981081632
        },
        "over15": {
          "n": 216,
          "brier": 0.17847860044062683,
          "baseline": 0.17229635214469652,
          "skill": -0.03588148105850997,
          "logLoss": 0.5440866836636795,
          "logLossBaseline": 0.5293569817147495,
          "logLossSkill": -0.027825649717919898
        },
        "over25": {
          "n": 216,
          "brier": 0.25919939674261244,
          "baseline": 0.25155592392725434,
          "skill": -0.03038478560166391,
          "logLoss": 0.7123465190037287,
          "logLossBaseline": 0.6962615950087584,
          "logLossSkill": -0.023101840041555022
        },
        "over35": {
          "n": 216,
          "brier": 0.2007858134451176,
          "baseline": 0.1901221365793561,
          "skill": -0.056088560004744714,
          "logLoss": 0.5951737710239363,
          "logLossBaseline": 0.5682393628509668,
          "logLossSkill": -0.04739975780247674
        }
      }
    },
    {
      "id": "mex.1",
      "name": "Liga MX",
      "n": 141,
      "skipped": 4,
      "hits": 56,
      "hitRate": 0.3971631205673759,
      "markets": {
        "1x2": {
          "n": 141,
          "brier": 0.6477446206561355,
          "baseline": 0.6736632319414173,
          "skill": 0.03847413671455313,
          "logLoss": 1.0751609279710295,
          "logLossBaseline": 1.1067413807056177,
          "logLossSkill": 0.028534627226510345
        },
        "btts": {
          "n": 141,
          "brier": 0.24305232578435396,
          "baseline": 0.2401892830903036,
          "skill": -0.011919943542918032,
          "logLoss": 0.6785976883209522,
          "logLossBaseline": 0.6734245794287711,
          "logLossSkill": -0.007681793997732056
        },
        "over15": {
          "n": 141,
          "brier": 0.16339731202414412,
          "baseline": 0.1600650803729524,
          "skill": -0.020817980058033925,
          "logLoss": 0.5088722621981406,
          "logLossBaseline": 0.501128903465079,
          "logLossSkill": -0.015451830216776319
        },
        "over25": {
          "n": 141,
          "brier": 0.2543517889536131,
          "baseline": 0.24985412577464525,
          "skill": -0.018001156334814805,
          "logLoss": 0.701904621525491,
          "logLossBaseline": 0.6928711322357449,
          "logLossSkill": -0.013037762535432762
        },
        "over35": {
          "n": 141,
          "brier": 0.22721205141987005,
          "baseline": 0.22507693906578208,
          "skill": -0.009486144439986077,
          "logLoss": 0.6493536653600535,
          "logLossBaseline": 0.6425300777928127,
          "logLossSkill": -0.010619872599086477
        }
      }
    },
    {
      "id": "esp.1",
      "name": "LaLiga",
      "n": 137,
      "skipped": 11,
      "hits": 70,
      "hitRate": 0.5109489051094891,
      "markets": {
        "1x2": {
          "n": 137,
          "brier": 0.5965117397822808,
          "baseline": 0.6468335638603552,
          "skill": 0.07779717517710383,
          "logLoss": 1.0033461683998384,
          "logLossBaseline": 1.0696744443107955,
          "logLossSkill": 0.06200790928841271
        },
        "btts": {
          "n": 137,
          "brier": 0.24278147807038586,
          "baseline": 0.24673329206885503,
          "skill": 0.016016541445758148,
          "logLoss": 0.6785129642303827,
          "logLossBaseline": 0.6866162681033146,
          "logLossSkill": 0.011801794174373659
        },
        "over15": {
          "n": 137,
          "brier": 0.1859379064495055,
          "baseline": 0.18796294738030334,
          "skill": 0.010773617667851232,
          "logLoss": 0.5582980600471078,
          "logLossBaseline": 0.5642910040875503,
          "logLossSkill": 0.010620307601984513
        },
        "over25": {
          "n": 137,
          "brier": 0.23865136546058446,
          "baseline": 0.25005867491064243,
          "skill": 0.0456185311472771,
          "logLoss": 0.6694482795337079,
          "logLossBaseline": 0.6932647260718744,
          "logLossSkill": 0.03435404347357107
        },
        "over35": {
          "n": 137,
          "brier": 0.20703024235106743,
          "baseline": 0.2078499968429526,
          "skill": 0.00394397163500837,
          "logLoss": 0.6039849774358562,
          "logLossBaseline": 0.606757763131486,
          "logLossSkill": 0.0045698396693260035
        }
      }
    },
    {
      "id": "ita.1",
      "name": "Serie A",
      "n": 135,
      "skipped": 11,
      "hits": 74,
      "hitRate": 0.5481481481481482,
      "markets": {
        "1x2": {
          "n": 135,
          "brier": 0.5597438604061306,
          "baseline": 0.6399338325163454,
          "skill": 0.12530978678669347,
          "logLoss": 0.9498580760589793,
          "logLossBaseline": 1.0557221780924118,
          "logLossSkill": 0.1002764782536999
        },
        "btts": {
          "n": 135,
          "brier": 0.2485454595052698,
          "baseline": 0.2529893980895635,
          "skill": 0.01756571072879687,
          "logLoss": 0.6905414789405124,
          "logLossBaseline": 0.6991365298957178,
          "logLossSkill": 0.012293808988192101
        },
        "over15": {
          "n": 135,
          "brier": 0.1552260447614554,
          "baseline": 0.16203975022645528,
          "skill": 0.04204959249491269,
          "logLoss": 0.4875655669923557,
          "logLossBaseline": 0.5076025938639253,
          "logLossSkill": 0.039473846496814735
        },
        "over25": {
          "n": 135,
          "brier": 0.24841531006042916,
          "baseline": 0.25336367068261034,
          "skill": 0.01953066360638578,
          "logLoss": 0.689901176468437,
          "logLossBaseline": 0.6998838585343685,
          "logLossSkill": 0.014263340901783828
        },
        "over35": {
          "n": 135,
          "brier": 0.2050106247076739,
          "baseline": 0.20436950771589613,
          "skill": -0.003137048177798585,
          "logLoss": 0.5997680882554578,
          "logLossBaseline": 0.6000193778760529,
          "logLossSkill": 0.00041880250848658207
        }
      }
    },
    {
      "id": "eng.1",
      "name": "Premier League",
      "n": 132,
      "skipped": 11,
      "hits": 61,
      "hitRate": 0.4621212121212121,
      "markets": {
        "1x2": {
          "n": 132,
          "brier": 0.6320610326519961,
          "baseline": 0.6516920452679503,
          "skill": 0.030123142914661116,
          "logLoss": 1.0509064941411124,
          "logLossBaseline": 1.0775001988277646,
          "logLossSkill": 0.02468092786951137
        },
        "btts": {
          "n": 132,
          "brier": 0.2553414630352502,
          "baseline": 0.24829160723240795,
          "skill": -0.02839345188274267,
          "logLoss": 0.7046321703699091,
          "logLossBaseline": 0.6897342488329514,
          "logLossSkill": -0.021599509611369028
        },
        "over15": {
          "n": 132,
          "brier": 0.17476582880622035,
          "baseline": 0.17175485259354928,
          "skill": -0.017530661679739712,
          "logLoss": 0.536526553092746,
          "logLossBaseline": 0.5274736977785779,
          "logLossSkill": -0.0171626667875453
        },
        "over25": {
          "n": 132,
          "brier": 0.25851668163558944,
          "baseline": 0.25074824318696104,
          "skill": -0.030981028420750123,
          "logLoss": 0.7110315230243514,
          "logLossBaseline": 0.6946558046888256,
          "logLossSkill": -0.023573859492704186
        },
        "over35": {
          "n": 132,
          "brier": 0.21875256465159354,
          "baseline": 0.20894169272085938,
          "skill": -0.04695507058919657,
          "logLoss": 0.6325008622882866,
          "logLossBaseline": 0.6088740681720586,
          "logLossSkill": -0.038804073537175965
        }
      }
    },
    {
      "id": "usa.1",
      "name": "MLS",
      "n": 124,
      "skipped": 0,
      "hits": 60,
      "hitRate": 0.4838709677419355,
      "markets": {
        "1x2": {
          "n": 124,
          "brier": 0.6147602291440157,
          "baseline": 0.6473126320996572,
          "skill": 0.050288533455700946,
          "logLoss": 1.0264308974398446,
          "logLossBaseline": 1.0692456732877398,
          "logLossSkill": 0.040042037968923805
        },
        "btts": {
          "n": 124,
          "brier": 0.23954218776483718,
          "baseline": 0.23806474222976,
          "skill": -0.006206066136627886,
          "logLoss": 0.6718257997237338,
          "logLossBaseline": 0.66915738486719,
          "logLossSkill": -0.003987723840294111
        },
        "over15": {
          "n": 124,
          "brier": 0.12631661108401013,
          "baseline": 0.12587624031642713,
          "skill": -0.00349844233094343,
          "logLoss": 0.4230514289975264,
          "logLossBaseline": 0.42048566924956243,
          "logLossSkill": -0.006101895820951775
        },
        "over25": {
          "n": 124,
          "brier": 0.22059775496219497,
          "baseline": 0.22325602907655004,
          "skill": 0.01190684133078257,
          "logLoss": 0.6313626216428486,
          "logLossBaseline": 0.6388508791626317,
          "logLossSkill": 0.011721448250330724
        },
        "over35": {
          "n": 124,
          "brier": 0.2446536994323988,
          "baseline": 0.2540206545482491,
          "skill": 0.03687477749598167,
          "logLoss": 0.6845860590935142,
          "logLossBaseline": 0.7013818502607155,
          "logLossSkill": 0.023946714847209116
        }
      }
    },
    {
      "id": "gua.1",
      "name": "Liga Nacional de Guatemala",
      "n": 116,
      "skipped": 7,
      "hits": 59,
      "hitRate": 0.5086206896551724,
      "markets": {
        "1x2": {
          "n": 116,
          "brier": 0.5981654376461276,
          "baseline": 0.5590774665939096,
          "skill": -0.06991512516209131,
          "logLoss": 0.9986550512225442,
          "logLossBaseline": 0.9497725216365237,
          "logLossSkill": -0.051467618269048776
        },
        "btts": {
          "n": 116,
          "brier": 0.2599384395133741,
          "baseline": 0.2541495342367104,
          "skill": -0.022777556111009956,
          "logLoss": 0.7134188880368445,
          "logLossBaseline": 0.7014721119909291,
          "logLossSkill": -0.017031006424486295
        },
        "over15": {
          "n": 116,
          "brier": 0.16928681492663708,
          "baseline": 0.17563445310155065,
          "skill": 0.03614119019827744,
          "logLoss": 0.5227997215660727,
          "logLossBaseline": 0.5387048628936939,
          "logLossSkill": 0.029524777708865524
        },
        "over25": {
          "n": 116,
          "brier": 0.25443449306733595,
          "baseline": 0.25322947900812764,
          "skill": -0.00475858523236794,
          "logLoss": 0.70231356119144,
          "logLossBaseline": 0.699631967269462,
          "logLossSkill": -0.0038328636303508468
        },
        "over35": {
          "n": 116,
          "brier": 0.224239338815384,
          "baseline": 0.21390402043359355,
          "skill": -0.048317550838176127,
          "logLoss": 0.6504715699254511,
          "logLossBaseline": 0.6205872607382118,
          "logLossSkill": -0.048154886633816396
        }
      }
    },
    {
      "id": "ned.1",
      "name": "Eredivisie",
      "n": 112,
      "skipped": 12,
      "hits": 58,
      "hitRate": 0.5178571428571429,
      "markets": {
        "1x2": {
          "n": 112,
          "brier": 0.6149101796291607,
          "baseline": 0.6678923781861236,
          "skill": 0.07932744898340216,
          "logLoss": 1.029183375252752,
          "logLossBaseline": 1.0998742648419317,
          "logLossSkill": 0.06427179164823815
        },
        "btts": {
          "n": 112,
          "brier": 0.21066940459257225,
          "baseline": 0.2197104157909597,
          "skill": 0.04114967042340589,
          "logLoss": 0.6108752525780364,
          "logLossBaseline": 0.63146551313357,
          "logLossSkill": 0.03260710225227814
        },
        "over15": {
          "n": 112,
          "brier": 0.10375013066549685,
          "baseline": 0.10312363321616651,
          "skill": -0.0060752073001257845,
          "logLoss": 0.3598907217172929,
          "logLossBaseline": 0.3614114029023098,
          "logLossSkill": 0.00420761816811821
        },
        "over25": {
          "n": 112,
          "brier": 0.2204503803562543,
          "baseline": 0.21835247146790188,
          "skill": -0.009607900813986658,
          "logLoss": 0.6343417396948213,
          "logLossBaseline": 0.6287852205397418,
          "logLossSkill": -0.008836911195701846
        },
        "over35": {
          "n": 112,
          "brier": 0.2626179708250287,
          "baseline": 0.26498429874556745,
          "skill": 0.008930068429491622,
          "logLoss": 0.7194015821782715,
          "logLossBaseline": 0.7234235380311166,
          "logLossSkill": 0.0055596143080874905
        }
      }
    },
    {
      "id": "fra.1",
      "name": "Ligue 1",
      "n": 110,
      "skipped": 8,
      "hits": 57,
      "hitRate": 0.5181818181818182,
      "markets": {
        "1x2": {
          "n": 110,
          "brier": 0.6181275757473209,
          "baseline": 0.6345643438684012,
          "skill": 0.02590244516557494,
          "logLoss": 1.0266208913149648,
          "logLossBaseline": 1.0507579555198412,
          "logLossSkill": 0.022971098223029895
        },
        "btts": {
          "n": 110,
          "brier": 0.24712684585160014,
          "baseline": 0.2482603226040114,
          "skill": 0.004565678238561022,
          "logLoss": 0.6877830208980201,
          "logLossBaseline": 0.6896674456334961,
          "logLossSkill": 0.0027323672407721933
        },
        "over15": {
          "n": 110,
          "brier": 0.16465555815397714,
          "baseline": 0.1650158840826421,
          "skill": 0.0021835832996809357,
          "logLoss": 0.5137488640965578,
          "logLossBaseline": 0.5139053769388355,
          "logLossSkill": 0.0003045557592916692
        },
        "over25": {
          "n": 110,
          "brier": 0.2415701095370901,
          "baseline": 0.24756916242112822,
          "skill": 0.024231826069813223,
          "logLoss": 0.6764245172159546,
          "logLossBaseline": 0.688285837320359,
          "logLossSkill": 0.017233131151707215
        },
        "over35": {
          "n": 110,
          "brier": 0.2188569297865336,
          "baseline": 0.21484527879313886,
          "skill": -0.018672279027631244,
          "logLoss": 0.6295297638856483,
          "logLossBaseline": 0.621291427382974,
          "logLossSkill": -0.013260019597205908
        }
      }
    },
    {
      "id": "ger.1",
      "name": "Bundesliga",
      "n": 104,
      "skipped": 11,
      "hits": 47,
      "hitRate": 0.4519230769230769,
      "markets": {
        "1x2": {
          "n": 104,
          "brier": 0.6153343335082269,
          "baseline": 0.6322854148623696,
          "skill": 0.026809224055614922,
          "logLoss": 1.0233125651018447,
          "logLossBaseline": 1.0486822523241552,
          "logLossSkill": 0.02419196774436172
        },
        "btts": {
          "n": 104,
          "brier": 0.22246298794088576,
          "baseline": 0.22720607881588975,
          "skill": 0.020875721722425467,
          "logLoss": 0.6374982942199684,
          "logLossBaseline": 0.6470738230313786,
          "logLossSkill": 0.014798201488898544
        },
        "over15": {
          "n": 104,
          "brier": 0.12602780186115645,
          "baseline": 0.12439971145819304,
          "skill": -0.013087573788389095,
          "logLoss": 0.42473125457840405,
          "logLossBaseline": 0.4161068730931757,
          "logLossSkill": -0.020726361526110182
        },
        "over25": {
          "n": 104,
          "brier": 0.20937979624613767,
          "baseline": 0.21111294701622935,
          "skill": 0.008209590148719914,
          "logLoss": 0.6091350901403767,
          "logLossBaseline": 0.6138692619034406,
          "logLossSkill": 0.007712019573002493
        },
        "over35": {
          "n": 104,
          "brier": 0.2599485724478591,
          "baseline": 0.26056253936351564,
          "skill": 0.002356313064634241,
          "logLoss": 0.7136995117273729,
          "logLossBaseline": 0.714458661187218,
          "logLossSkill": 0.0010625519726832344
        }
      }
    },
    {
      "id": "uefa.champions",
      "name": "UEFA Champions League",
      "n": 17,
      "skipped": 49,
      "hits": 12,
      "hitRate": 0.7058823529411765,
      "markets": {
        "1x2": {
          "n": 17,
          "brier": 0.47437304287248816,
          "baseline": 0.5949440587858392,
          "skill": 0.20265941668433862,
          "logLoss": 0.8262292908716016,
          "logLossBaseline": 0.9594389223365088,
          "logLossSkill": 0.13884117932228934
        },
        "btts": {
          "n": 17,
          "brier": 0.23487429551696945,
          "baseline": 0.21544107875795956,
          "skill": -0.09020200265912348,
          "logLoss": 0.6762045475413038,
          "logLossBaseline": 0.6229870155159561,
          "logLossSkill": -0.08542318009834116
        },
        "over15": {
          "n": 17,
          "brier": 0.10149557646704424,
          "baseline": 0.10433604424172192,
          "skill": 0.027224223376697942,
          "logLoss": 0.35881312383113906,
          "logLossBaseline": 0.36458961685311747,
          "logLossSkill": 0.015843822080938708
        },
        "over25": {
          "n": 17,
          "brier": 0.16768925078859262,
          "baseline": 0.16235371929283945,
          "skill": -0.03286362344511118,
          "logLoss": 0.517653644227588,
          "logLossBaseline": 0.5103223902076095,
          "logLossSkill": -0.014365926639033022
        },
        "over35": {
          "n": 17,
          "brier": 0.24779829581577903,
          "baseline": 0.2570827557111402,
          "skill": 0.03611467392932899,
          "logLoss": 0.6882253863047781,
          "logLossBaseline": 0.7073307557085269,
          "logLossSkill": 0.027010517002913348
        }
      }
    }
  ],
  "calibration": {
    "oneX2": [
      {
        "from": 0,
        "to": 0.1,
        "n": 27,
        "predicted": 0.08512454515895171,
        "observed": 0.07407407407407407,
        "error": 0.011050471084877639
      },
      {
        "from": 0.1,
        "to": 0.2,
        "n": 383,
        "predicted": 0.1650313459643059,
        "observed": 0.16449086161879894,
        "error": 0.0005404843455069641
      },
      {
        "from": 0.2,
        "to": 0.3,
        "n": 1991,
        "predicted": 0.25562427000136556,
        "observed": 0.2466097438473129,
        "error": 0.009014526154052654
      },
      {
        "from": 0.3,
        "to": 0.4,
        "n": 1144,
        "predicted": 0.34523931559025745,
        "observed": 0.34702797202797203,
        "error": 0.0017886564377145864
      },
      {
        "from": 0.4,
        "to": 0.5,
        "n": 643,
        "predicted": 0.4462573152785312,
        "observed": 0.4494556765163297,
        "error": 0.0031983612377985415
      },
      {
        "from": 0.5,
        "to": 0.6,
        "n": 380,
        "predicted": 0.5449593828489208,
        "observed": 0.5631578947368421,
        "error": 0.01819851188792132
      },
      {
        "from": 0.6,
        "to": 0.7,
        "n": 137,
        "predicted": 0.6416598953052912,
        "observed": 0.6642335766423357,
        "error": 0.022573681337044516
      },
      {
        "from": 0.7,
        "to": 0.8,
        "n": 36,
        "predicted": 0.7367848806973708,
        "observed": 0.8888888888888888,
        "error": 0.15210400819151804
      },
      {
        "from": 0.8,
        "to": 0.9,
        "n": 5,
        "predicted": 0.8266505199579056,
        "observed": 0.6,
        "error": 0.22665051995790564
      }
    ],
    "btts": [
      {
        "from": 0.2,
        "to": 0.3,
        "n": 10,
        "predicted": 0.279353811625379,
        "observed": 0.6,
        "error": 0.320646188374621
      },
      {
        "from": 0.3,
        "to": 0.4,
        "n": 97,
        "predicted": 0.36303273445060114,
        "observed": 0.5051546391752577,
        "error": 0.14212190472465658
      },
      {
        "from": 0.4,
        "to": 0.5,
        "n": 386,
        "predicted": 0.4556970496749779,
        "observed": 0.5362694300518135,
        "error": 0.08057238037683556
      },
      {
        "from": 0.5,
        "to": 0.6,
        "n": 629,
        "predicted": 0.5504299056615951,
        "observed": 0.5548489666136724,
        "error": 0.004419060952077336
      },
      {
        "from": 0.6,
        "to": 0.7,
        "n": 359,
        "predicted": 0.6435572273706123,
        "observed": 0.6323119777158774,
        "error": 0.011245249654734835
      },
      {
        "from": 0.7,
        "to": 0.8,
        "n": 98,
        "predicted": 0.7300464477658785,
        "observed": 0.7142857142857143,
        "error": 0.015760733480164157
      },
      {
        "from": 0.8,
        "to": 0.9,
        "n": 3,
        "predicted": 0.8142315425679598,
        "observed": 0.3333333333333333,
        "error": 0.4808982092346265
      }
    ],
    "over25": [
      {
        "from": 0.1,
        "to": 0.2,
        "n": 6,
        "predicted": 0.18499232003503277,
        "observed": 0.8333333333333334,
        "error": 0.6483410132983006
      },
      {
        "from": 0.2,
        "to": 0.3,
        "n": 48,
        "predicted": 0.270819683448748,
        "observed": 0.3541666666666667,
        "error": 0.08334698321791867
      },
      {
        "from": 0.3,
        "to": 0.4,
        "n": 179,
        "predicted": 0.3578211549106709,
        "observed": 0.441340782122905,
        "error": 0.0835196272122341
      },
      {
        "from": 0.4,
        "to": 0.5,
        "n": 399,
        "predicted": 0.45282193192804415,
        "observed": 0.5087719298245614,
        "error": 0.05594999789651728
      },
      {
        "from": 0.5,
        "to": 0.6,
        "n": 484,
        "predicted": 0.5480068355108481,
        "observed": 0.5392561983471075,
        "error": 0.008750637163740582
      },
      {
        "from": 0.6,
        "to": 0.7,
        "n": 296,
        "predicted": 0.6440794092573708,
        "observed": 0.6013513513513513,
        "error": 0.04272805790601952
      },
      {
        "from": 0.7,
        "to": 0.8,
        "n": 143,
        "predicted": 0.7391762027574245,
        "observed": 0.7412587412587412,
        "error": 0.0020825385013167885
      },
      {
        "from": 0.8,
        "to": 0.9,
        "n": 27,
        "predicted": 0.8325261677628525,
        "observed": 0.8518518518518519,
        "error": 0.019325684088999373
      }
    ]
  },
  "timeline": [
    {
      "month": "2026-04",
      "n": 30,
      "brier": 0.6043171656206969,
      "baseline": 0.6667347588741916,
      "skill": 0.09361682801552051
    },
    {
      "month": "2026-05",
      "n": 250,
      "brier": 0.6284658036901711,
      "baseline": 0.6350067226270854,
      "skill": 0.010300550693154498
    },
    {
      "month": "2026-07",
      "n": 71,
      "brier": 0.622542513756795,
      "baseline": 0.6695750132637286,
      "skill": 0.07024231576038309
    },
    {
      "month": "2026-08",
      "n": 250,
      "brier": 0.6065563625977203,
      "baseline": 0.6264002423117486,
      "skill": 0.0316792337767845
    },
    {
      "month": "2026-09",
      "n": 332,
      "brier": 0.622498494110084,
      "baseline": 0.6546031878419315,
      "skill": 0.04904451174105795
    },
    {
      "month": "2026-10",
      "n": 471,
      "brier": 0.6122647820761453,
      "baseline": 0.6378738157972168,
      "skill": 0.040147491693267257
    },
    {
      "month": "2026-11",
      "n": 178,
      "brier": 0.5658698152956727,
      "baseline": 0.635239802938526,
      "skill": 0.10920283540476827
    }
  ],
  "testWindows": [
    {
      "id": "arg.1",
      "name": "Primera División Argentina",
      "total": 791,
      "testStart": 553,
      "testFrom": "2026-04-19T00:45Z"
    },
    {
      "id": "bra.1",
      "name": "Brasileirão",
      "total": 718,
      "testStart": 502,
      "testFrom": "2026-05-03T21:30Z"
    },
    {
      "id": "mex.1",
      "name": "Liga MX",
      "total": 481,
      "testStart": 336,
      "testFrom": "2026-05-25T01:00Z"
    },
    {
      "id": "gua.1",
      "name": "Liga Nacional de Guatemala",
      "total": 407,
      "testStart": 284,
      "testFrom": "2026-05-10T00:00Z"
    },
    {
      "id": "ned.1",
      "name": "Eredivisie",
      "total": 411,
      "testStart": 287,
      "testFrom": "2026-05-10T14:45Z"
    },
    {
      "id": "esp.1",
      "name": "LaLiga",
      "total": 493,
      "testStart": 345,
      "testFrom": "2026-05-12T17:00Z"
    },
    {
      "id": "fra.1",
      "name": "Ligue 1",
      "total": 393,
      "testStart": 275,
      "testFrom": "2026-05-02T13:00Z"
    },
    {
      "id": "eng.1",
      "name": "Premier League",
      "total": 474,
      "testStart": 331,
      "testFrom": "2026-04-25T14:00Z"
    },
    {
      "id": "ger.1",
      "name": "Bundesliga",
      "total": 381,
      "testStart": 266,
      "testFrom": "2026-04-24T18:30Z"
    },
    {
      "id": "ita.1",
      "name": "Serie A",
      "total": 484,
      "testStart": 338,
      "testFrom": "2026-05-02T18:45Z"
    },
    {
      "id": "uefa.champions",
      "name": "UEFA Champions League",
      "total": 220,
      "testStart": 154,
      "testFrom": "2026-09-09T16:45Z"
    },
    {
      "id": "usa.1",
      "name": "MLS",
      "total": 411,
      "testStart": 287,
      "testFrom": "2026-09-10T02:30Z"
    },
    {
      "id": "uefa.europa",
      "name": "UEFA Europa League",
      "total": 8,
      "testStart": 20,
      "testFrom": null
    },
    {
      "id": "uefa.europa.conf",
      "name": "UEFA Conference League",
      "total": 6,
      "testStart": 20,
      "testFrom": null
    }
  ],
  "notes": [
    "Solo se evalúan partidos del último 30% de cada liga; cada predicción usa exclusivamente resultados anteriores.",
    "No se usan alineaciones; el clima y el árbitro están excluidos del cálculo: el backtest mide el núcleo del motor, no el contexto completo.",
    "La tabla de temporada se reconstruye con los goles previos del mismo historial; en live, la app usa la tabla real de ESPN.",
    "El Brier es un error cuadrático: menor es mejor. El baseline es la frecuencia previa de cada mercado en la misma liga.",
    "El historial de aciertos cuenta solo el resultado 1X2 más probable del modelo: acierta si coincide con el signo final. No es una recomendación.",
    "Una muestra de dos temporadas no garantiza el futuro; los resultados por liga pueden variar mucho."
  ]
};
