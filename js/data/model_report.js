// Generado por pipeline/models.py. No editar a mano.
// Versión 3.0.0 · 2026-11-20T06:04:21.173226Z
export const MODEL_REPORT = {
  "version": "3.0.0",
  "generatedAt": "2026-11-20T06:04:21.173226Z",
  "engine": "motor-nox-v1",
  "engineVersion": "1.0",
  "modelName": "OX V1.0",
  "title": "Ensamble OX",
  "description": "Cuatro modelos calibrados y combinados con pesos aprendidos en validación. El ensamble 1X2 combina la logística Elo + xG + tiros con la logística core; los mercados binarios se apoyan en Poisson. El Poisson sigue siendo la referencia explicable y el fallback.",
  "split": {
    "method": "temporal",
    "train": {
      "seasons": [
        "2020-21",
        "2021-22",
        "2022-23"
      ],
      "matches": 2280,
      "from": "2020-09-12T12:30",
      "to": "2023-06-04T20:00"
    },
    "validation": {
      "seasons": [
        "2023-24"
      ],
      "matches": 752,
      "matches_available": 760,
      "from": "2023-08-11T18:30",
      "to": "2024-05-26T20:00",
      "calibration": {
        "matches": 376,
        "from": "2023-08-11T18:30",
        "to": "2024-01-03T18:15"
      },
      "weights": {
        "matches": 376,
        "from": "2024-01-03T20:30",
        "to": "2024-05-26T20:00"
      }
    },
    "test": {
      "seasons": [
        "2024-25",
        "2025-26"
      ],
      "matches": 1504,
      "matches_available": 1520,
      "from": "2024-08-15T18:00",
      "to": "2026-05-24T20:00",
      "coverage": 0.9894736842105263
    },
    "note": "El test se evalúa una sola vez. La validación se parte por fecha: la primera mitad calibra la temperatura y la segunda aprende los pesos del ensamble. El mercado de cierre no se usa como feature."
  },
  "sample": {
    "feature_version": "features-2.2.0",
    "poisson_baseline_version": "1.0",
    "poisson_engine": "motor-nox-v1",
    "poisson_engine_version": "1.0",
    "poisson_rows": 2256,
    "train": 2280,
    "validation": 752,
    "calibration": 376,
    "weights": 376,
    "test": 1504,
    "test_available": 1520,
    "leagues": 2,
    "seasons": [
      "2024-25",
      "2025-26"
    ]
  },
  "headline": {
    "n": 1504,
    "hits": 802,
    "accuracy": 0.5332446808510638,
    "logLoss": 0.9890979426477566,
    "brier": 0.5885555731985193,
    "ece": 0.03610680810273264,
    "baseline": {
      "n": 1504,
      "hits": 664,
      "accuracy": 0.44148936170212766,
      "logLoss": 1.0713654506354542,
      "brier": 0.6479921317852302,
      "ece": 0.004647256438969849,
      "kind": "baseline",
      "probabilities": [
        0.4368421052631579,
        0.24868421052631579,
        0.3144736842105263
      ]
    },
    "skill": 0.09172419798209919,
    "logLossSkill": 0.07678753121906501,
    "ci": {
      "accuracy": [
        0.5093085106382979,
        0.5578623670212766
      ],
      "logLoss": [
        0.9636545933339081,
        1.0145306959199432
      ],
      "brier": [
        0.5706897608447015,
        0.6061535430057778
      ]
    },
    "currentStreak": 1,
    "bestStreak": 18,
    "recent": [
      {
        "matchId": "fd_esp.1_2025-26_villarreal_atletico_madrid",
        "date": "2026-05-24T20:00",
        "leagueId": "esp.1",
        "homeName": "Villarreal",
        "awayName": "Ath Madrid",
        "homeGoals": 5,
        "awayGoals": 1,
        "predicted": "home",
        "actual": "home",
        "hit": true,
        "probs": {
          "home": 0.4671787257949045,
          "draw": 0.25565583312808304,
          "away": 0.2771654410770124
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_west_ham_leeds",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "West Ham",
        "awayName": "Leeds",
        "homeGoals": 3,
        "awayGoals": 0,
        "predicted": "away",
        "actual": "home",
        "hit": false,
        "probs": {
          "home": 0.31837554122135014,
          "draw": 0.24036700720962834,
          "away": 0.4412574515690215
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_tottenham_everton",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Tottenham",
        "awayName": "Everton",
        "homeGoals": 1,
        "awayGoals": 0,
        "predicted": "home",
        "actual": "home",
        "hit": true,
        "probs": {
          "home": 0.4471020767773256,
          "draw": 0.23535731800610277,
          "away": 0.31754060521657157
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_sunderland_chelsea",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Sunderland",
        "awayName": "Chelsea",
        "homeGoals": 2,
        "awayGoals": 1,
        "predicted": "away",
        "actual": "home",
        "hit": false,
        "probs": {
          "home": 0.25814630299462527,
          "draw": 0.18651571751419044,
          "away": 0.5553379794911842
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_nottingham_forest_bournemouth",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Nott'm Forest",
        "awayName": "Bournemouth",
        "homeGoals": 1,
        "awayGoals": 1,
        "predicted": "away",
        "actual": "draw",
        "hit": false,
        "probs": {
          "home": 0.3052304802737407,
          "draw": 0.20587548078719792,
          "away": 0.4888940389390613
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_manchester_city_aston_villa",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Man City",
        "awayName": "Aston Villa",
        "homeGoals": 1,
        "awayGoals": 2,
        "predicted": "home",
        "actual": "away",
        "hit": false,
        "probs": {
          "home": 0.7371430866257866,
          "draw": 0.1609074759785311,
          "away": 0.10194943739568221
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_liverpool_brentford",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Liverpool",
        "awayName": "Brentford",
        "homeGoals": 1,
        "awayGoals": 1,
        "predicted": "home",
        "actual": "draw",
        "hit": false,
        "probs": {
          "home": 0.5970051993994772,
          "draw": 0.19010831374850798,
          "away": 0.21288648685201478
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_fulham_newcastle",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Fulham",
        "awayName": "Newcastle",
        "homeGoals": 2,
        "awayGoals": 0,
        "predicted": "home",
        "actual": "home",
        "hit": true,
        "probs": {
          "home": 0.43303772674117347,
          "draw": 0.20092086014483188,
          "away": 0.3660414131139945
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_crystal_palace_arsenal",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Crystal Palace",
        "awayName": "Arsenal",
        "homeGoals": 1,
        "awayGoals": 2,
        "predicted": "away",
        "actual": "away",
        "hit": true,
        "probs": {
          "home": 0.1749125564438051,
          "draw": 0.21524966888603447,
          "away": 0.6098377746701604
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_burnley_wolverhampton",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Burnley",
        "awayName": "Wolves",
        "homeGoals": 1,
        "awayGoals": 1,
        "predicted": "away",
        "actual": "draw",
        "hit": false,
        "probs": {
          "home": 0.36609181963498194,
          "draw": 0.21146723837963982,
          "away": 0.4224409419853782
        }
      },
      {
        "matchId": "fd_eng.1_2025-26_brighton_manchester_united",
        "date": "2026-05-24T16:00",
        "leagueId": "eng.1",
        "homeName": "Brighton",
        "awayName": "Man United",
        "homeGoals": 0,
        "awayGoals": 3,
        "predicted": "away",
        "actual": "away",
        "hit": true,
        "probs": {
          "home": 0.3791127222473353,
          "draw": 0.20877083247105174,
          "away": 0.41211644528161284
        }
      },
      {
        "matchId": "fd_esp.1_2025-26_valencia_barcelona",
        "date": "2026-05-23T20:00",
        "leagueId": "esp.1",
        "homeName": "Valencia",
        "awayName": "Barcelona",
        "homeGoals": 3,
        "awayGoals": 1,
        "predicted": "away",
        "actual": "home",
        "hit": false,
        "probs": {
          "home": 0.10250989887442702,
          "draw": 0.16391892404923686,
          "away": 0.733571177076336
        }
      },
      {
        "matchId": "fd_esp.1_2025-26_real_madrid_athletic_club",
        "date": "2026-05-23T20:00",
        "leagueId": "esp.1",
        "homeName": "Real Madrid",
        "awayName": "Ath Bilbao",
        "homeGoals": 4,
        "awayGoals": 2,
        "predicted": "home",
        "actual": "home",
        "hit": true,
        "probs": {
          "home": 0.6884752670158268,
          "draw": 0.19953117468247153,
          "away": 0.11199355830170152
        }
      },
      {
        "matchId": "fd_esp.1_2025-26_real_betis_levante",
        "date": "2026-05-23T20:00",
        "leagueId": "esp.1",
        "homeName": "Betis",
        "awayName": "Levante",
        "homeGoals": 2,
        "awayGoals": 1,
        "predicted": "home",
        "actual": "home",
        "hit": true,
        "probs": {
          "home": 0.5372053026814179,
          "draw": 0.24174648239256818,
          "away": 0.2210482149260139
        }
      },
      {
        "matchId": "fd_esp.1_2025-26_mallorca_real_oviedo",
        "date": "2026-05-23T20:00",
        "leagueId": "esp.1",
        "homeName": "Mallorca",
        "awayName": "Oviedo",
        "homeGoals": 3,
        "awayGoals": 0,
        "predicted": "home",
        "actual": "home",
        "hit": true,
        "probs": {
          "home": 0.553004508474488,
          "draw": 0.25245516273928215,
          "away": 0.1945403287862298
        }
      }
    ],
    "market": "1x2",
    "label": "1X2",
    "poisson": {
      "n": 1504,
      "hits": 758,
      "accuracy": 0.5039893617021277,
      "logLoss": 1.0094160880700793,
      "brier": 0.6043316923178546,
      "ece": 0.02214217252047965,
      "baseline": {
        "n": 1504,
        "hits": 664,
        "accuracy": 0.44148936170212766,
        "logLoss": 1.0713654506354542,
        "brier": 0.6479921317852302,
        "ece": 0.004647256438969849,
        "kind": "baseline",
        "probabilities": [
          0.4368421052631579,
          0.24868421052631579,
          0.3144736842105263
        ]
      },
      "skill": 0.06737803952509469,
      "logLossSkill": 0.05782281156129421
    },
    "delta": {
      "accuracy": 0.029255319148936088,
      "logLoss": -0.020318145422322686,
      "brier": -0.015776119119335297
    }
  },
  "markets": {
    "1x2": {
      "n": 1504,
      "hits": 802,
      "accuracy": 0.5332446808510638,
      "logLoss": 0.9890979426477566,
      "brier": 0.5885555731985193,
      "ece": 0.03610680810273264,
      "baseline": {
        "n": 1504,
        "hits": 664,
        "accuracy": 0.44148936170212766,
        "logLoss": 1.0713654506354542,
        "brier": 0.6479921317852302,
        "ece": 0.004647256438969849,
        "kind": "baseline",
        "probabilities": [
          0.4368421052631579,
          0.24868421052631579,
          0.3144736842105263
        ]
      },
      "skill": 0.09172419798209919,
      "logLossSkill": 0.07678753121906501,
      "ci": {
        "accuracy": [
          0.5093085106382979,
          0.5578623670212766
        ],
        "logLoss": [
          0.9636545933339081,
          1.0145306959199432
        ],
        "brier": [
          0.5706897608447015,
          0.6061535430057778
        ]
      },
      "poisson": {
        "n": 1504,
        "hits": 758,
        "accuracy": 0.5039893617021277,
        "logLoss": 1.0094160880700793,
        "brier": 0.6043316923178546,
        "ece": 0.02214217252047965,
        "baseline": {
          "n": 1504,
          "hits": 664,
          "accuracy": 0.44148936170212766,
          "logLoss": 1.0713654506354542,
          "brier": 0.6479921317852302,
          "ece": 0.004647256438969849,
          "kind": "baseline",
          "probabilities": [
            0.4368421052631579,
            0.24868421052631579,
            0.3144736842105263
          ]
        },
        "skill": 0.06737803952509469,
        "logLossSkill": 0.05782281156129421
      },
      "delta": {
        "accuracy": 0.029255319148936088,
        "logLoss": -0.020318145422322686,
        "brier": -0.015776119119335297
      },
      "label": "1X2",
      "kind": "multi",
      "weights": {
        "poisson": 3.262093286465761e-17,
        "logit_xg_elo": 0.0,
        "logit_core": 0.42679177738048457,
        "logit_xg_shots": 0.5732082226195153
      },
      "weight_loss": 0.922857198007873,
      "models": {
        "poisson": {
          "n": 1504,
          "hits": 758,
          "accuracy": 0.5039893617021277,
          "logLoss": 1.0094160880700793,
          "brier": 0.6043316923178546,
          "ece": 0.02214217252047965
        },
        "logit_xg_elo": {
          "n": 1504,
          "hits": 801,
          "accuracy": 0.5325797872340425,
          "logLoss": 0.9899369418628066,
          "brier": 0.5889051131077614,
          "ece": 0.03578547160203265
        },
        "logit_core": {
          "n": 1504,
          "hits": 788,
          "accuracy": 0.523936170212766,
          "logLoss": 0.9946736055924585,
          "brier": 0.5920310874018208,
          "ece": 0.030118047560379765
        },
        "logit_xg_shots": {
          "n": 1504,
          "hits": 799,
          "accuracy": 0.53125,
          "logLoss": 0.9880191251975448,
          "brier": 0.5877359003086773,
          "ece": 0.040190066592154544
        }
      },
      "temperatures": {
        "poisson": 0.7907848927448622,
        "logit_xg_elo": 0.9297103139427606,
        "logit_core": 0.9207773169265023,
        "logit_xg_shots": 0.918451443646904
      },
      "fallbacks": 0
    },
    "btts": {
      "n": 1504,
      "hits": 826,
      "accuracy": 0.5492021276595744,
      "logLoss": 0.6887113191710885,
      "brier": 0.2477622925909434,
      "ece": 0.048632849971278286,
      "baseline": {
        "n": 1504,
        "hits": 847,
        "accuracy": 0.5631648936170213,
        "logLoss": 0.6926027174294642,
        "brier": 0.24972777016496076,
        "ece": 0.060971911160880965,
        "kind": "baseline",
        "probability": 0.5021929824561403
      },
      "skill": 0.007870480614627029,
      "logLossSkill": 0.005618514280189779,
      "ci": {
        "accuracy": [
          0.5252659574468085,
          0.5738031914893617
        ],
        "logLoss": [
          0.6822508075542931,
          0.6941892505474949
        ],
        "brier": [
          0.24456961884312595,
          0.25044432645625886
        ]
      },
      "poisson": {
        "n": 1504,
        "hits": 826,
        "accuracy": 0.5492021276595744,
        "logLoss": 0.6887113191710885,
        "brier": 0.2477622925909434,
        "ece": 0.048632849971278314,
        "baseline": {
          "n": 1504,
          "hits": 847,
          "accuracy": 0.5631648936170213,
          "logLoss": 0.6926027174294642,
          "brier": 0.24972777016496076,
          "ece": 0.060971911160880965,
          "kind": "baseline",
          "probability": 0.5021929824561403
        },
        "skill": 0.007870480614627029,
        "logLossSkill": 0.005618514280189779
      },
      "delta": {
        "accuracy": 0.0,
        "logLoss": 0.0,
        "brier": 0.0
      },
      "label": "Ambos anotan",
      "kind": "binary",
      "weights": {
        "poisson": 0.9999999999999998,
        "logit_xg_elo": 2.810252031082427e-16,
        "logit_core": 0.0,
        "logit_xg_shots": 0.0
      },
      "weight_loss": 0.6749120124518302,
      "models": {
        "poisson": {
          "n": 1504,
          "hits": 826,
          "accuracy": 0.5492021276595744,
          "logLoss": 0.6887113191710885,
          "brier": 0.2477622925909434,
          "ece": 0.048632849971278314
        },
        "logit_xg_elo": {
          "n": 1504,
          "hits": 766,
          "accuracy": 0.5093085106382979,
          "logLoss": 0.6933928642115276,
          "brier": 0.25012286127026595,
          "ece": 0.05361422092967918
        },
        "logit_core": {
          "n": 1504,
          "hits": 794,
          "accuracy": 0.5279255319148937,
          "logLoss": 0.692704992427598,
          "brier": 0.24977858307516285,
          "ece": 0.0612310870485757
        },
        "logit_xg_shots": {
          "n": 1504,
          "hits": 791,
          "accuracy": 0.5259308510638298,
          "logLoss": 0.6927283264443217,
          "brier": 0.24979071995189325,
          "ece": 0.05828216678312962
        }
      },
      "temperatures": {
        "poisson": 1.3379268762734156,
        "logit_xg_elo": 0.5000004897189497,
        "logit_core": 2.999999324844608,
        "logit_xg_shots": 0.9849702934025492
      },
      "fallbacks": 0
    },
    "over15": {
      "n": 1504,
      "hits": 1169,
      "accuracy": 0.7772606382978723,
      "logLoss": 0.5252799569301365,
      "brier": 0.17140573915615234,
      "ece": 0.023886716639338744,
      "baseline": {
        "n": 1504,
        "hits": 1170,
        "accuracy": 0.7779255319148937,
        "logLoss": 0.5351096481136062,
        "brier": 0.1748649420771039,
        "ece": 0.04590798805524454,
        "kind": "baseline",
        "probability": 0.7320175438596491
      },
      "skill": 0.019782140890346578,
      "logLossSkill": 0.018369489726305144,
      "ci": {
        "accuracy": [
          0.7566323138297872,
          0.7965425531914894
        ],
        "logLoss": [
          0.5011791816158027,
          0.5509676831902317
        ],
        "brier": [
          0.16117188792533113,
          0.18248529510924108
        ]
      },
      "poisson": {
        "n": 1504,
        "hits": 1165,
        "accuracy": 0.7746010638297872,
        "logLoss": 0.5296034689069921,
        "brier": 0.17317959357453763,
        "ece": 0.040276469994524444,
        "baseline": {
          "n": 1504,
          "hits": 1170,
          "accuracy": 0.7779255319148937,
          "logLoss": 0.5351096481136062,
          "brier": 0.1748649420771039,
          "ece": 0.04590798805524454,
          "kind": "baseline",
          "probability": 0.7320175438596491
        },
        "skill": 0.009638001091282988,
        "logLossSkill": 0.010289814855749202
      },
      "delta": {
        "accuracy": 0.0026595744680850686,
        "logLoss": -0.004323511976855543,
        "brier": -0.00177385441838529
      },
      "label": "Más de 1.5",
      "kind": "binary",
      "weights": {
        "poisson": 0.6391748439967436,
        "logit_xg_elo": 0.0,
        "logit_core": 0.3608251560032565,
        "logit_xg_shots": 0.0
      },
      "weight_loss": 0.4949334423863395,
      "models": {
        "poisson": {
          "n": 1504,
          "hits": 1165,
          "accuracy": 0.7746010638297872,
          "logLoss": 0.5296034689069921,
          "brier": 0.17317959357453763,
          "ece": 0.040276469994524444
        },
        "logit_xg_elo": {
          "n": 1504,
          "hits": 1170,
          "accuracy": 0.7779255319148937,
          "logLoss": 0.5259929124687558,
          "brier": 0.17155974444376024,
          "ece": 0.009979190039380754
        },
        "logit_core": {
          "n": 1504,
          "hits": 1169,
          "accuracy": 0.7772606382978723,
          "logLoss": 0.5375590003026978,
          "brier": 0.17377284704228374,
          "ece": 0.011224594135156666
        },
        "logit_xg_shots": {
          "n": 1504,
          "hits": 1170,
          "accuracy": 0.7779255319148937,
          "logLoss": 0.5271422604376125,
          "brier": 0.1720687582756276,
          "ece": 0.013270016348803277
        }
      },
      "temperatures": {
        "poisson": 0.9896614982408373,
        "logit_xg_elo": 0.7647144028501809,
        "logit_core": 0.8036079703330822,
        "logit_xg_shots": 0.7686818299071848
      },
      "fallbacks": 0
    },
    "over25": {
      "n": 1504,
      "hits": 829,
      "accuracy": 0.5511968085106383,
      "logLoss": 0.687371502578751,
      "brier": 0.24714779860445213,
      "ece": 0.018860104736781565,
      "baseline": {
        "n": 1504,
        "hits": 710,
        "accuracy": 0.4720744680851064,
        "logLoss": 0.6948209593120759,
        "brier": 0.25083670589313906,
        "ece": 0.040206233669279445,
        "kind": "baseline",
        "probability": 0.48771929824561405
      },
      "skill": 0.014706409397109765,
      "logLossSkill": 0.010721404749649999,
      "ci": {
        "accuracy": [
          0.5246010638297872,
          0.5771442819148936
        ],
        "logLoss": [
          0.6804074735851622,
          0.6938279203001961
        ],
        "brier": [
          0.24370349005082134,
          0.2503052102373272
        ]
      },
      "poisson": {
        "n": 1504,
        "hits": 829,
        "accuracy": 0.5511968085106383,
        "logLoss": 0.687371502578751,
        "brier": 0.24714779860445213,
        "ece": 0.018860104736781565,
        "baseline": {
          "n": 1504,
          "hits": 710,
          "accuracy": 0.4720744680851064,
          "logLoss": 0.6948209593120759,
          "brier": 0.25083670589313906,
          "ece": 0.040206233669279445,
          "kind": "baseline",
          "probability": 0.48771929824561405
        },
        "skill": 0.014706409397109765,
        "logLossSkill": 0.010721404749649999
      },
      "delta": {
        "accuracy": 0.0,
        "logLoss": 0.0,
        "brier": 0.0
      },
      "label": "Más de 2.5",
      "kind": "binary",
      "weights": {
        "poisson": 1.0,
        "logit_xg_elo": 4.163336342344337e-17,
        "logit_core": 1.138463400473807e-17,
        "logit_xg_shots": 0.0
      },
      "weight_loss": 0.6644259897143735,
      "models": {
        "poisson": {
          "n": 1504,
          "hits": 829,
          "accuracy": 0.5511968085106383,
          "logLoss": 0.687371502578751,
          "brier": 0.24714779860445213,
          "ece": 0.018860104736781565
        },
        "logit_xg_elo": {
          "n": 1504,
          "hits": 798,
          "accuracy": 0.5305851063829787,
          "logLoss": 0.6919038929952287,
          "brier": 0.24933526306526838,
          "ece": 0.042532286747686214
        },
        "logit_core": {
          "n": 1504,
          "hits": 787,
          "accuracy": 0.5232712765957447,
          "logLoss": 0.6978641766866469,
          "brier": 0.25129273533135293,
          "ece": 0.03436831609134532
        },
        "logit_xg_shots": {
          "n": 1504,
          "hits": 797,
          "accuracy": 0.5299202127659575,
          "logLoss": 0.6905809179455301,
          "brier": 0.24871447252981377,
          "ece": 0.0371295527353041
        }
      },
      "temperatures": {
        "poisson": 1.6680456691329282,
        "logit_xg_elo": 0.6748336734122008,
        "logit_core": 2.9999995569962326,
        "logit_xg_shots": 1.0802747783432414
      },
      "fallbacks": 0
    },
    "over35": {
      "n": 1504,
      "hits": 1063,
      "accuracy": 0.706781914893617,
      "logLoss": 0.5987585306232067,
      "brier": 0.20479610069274676,
      "ece": 0.050328060833491756,
      "baseline": {
        "n": 1504,
        "hits": 1079,
        "accuracy": 0.7174202127659575,
        "logLoss": 0.5955337927780836,
        "brier": 0.20279274555837146,
        "ece": 0.008018383725270584,
        "kind": "baseline",
        "probability": 0.27456140350877195
      },
      "skill": -0.009878830373637015,
      "logLossSkill": -0.005414869624912777,
      "ci": {
        "accuracy": [
          0.6854886968085107,
          0.7300531914893617
        ],
        "logLoss": [
          0.5815107664050848,
          0.6145115468032911
        ],
        "brier": [
          0.19678780809979982,
          0.21212819724688475
        ]
      },
      "poisson": {
        "n": 1504,
        "hits": 1063,
        "accuracy": 0.706781914893617,
        "logLoss": 0.5987585306232068,
        "brier": 0.20479610069274676,
        "ece": 0.050328060833491756,
        "baseline": {
          "n": 1504,
          "hits": 1079,
          "accuracy": 0.7174202127659575,
          "logLoss": 0.5955337927780836,
          "brier": 0.20279274555837146,
          "ece": 0.008018383725270584,
          "kind": "baseline",
          "probability": 0.27456140350877195
        },
        "skill": -0.009878830373637015,
        "logLossSkill": -0.005414869624912999
      },
      "delta": {
        "accuracy": 0.0,
        "logLoss": -1.1102230246251565e-16,
        "brier": 0.0
      },
      "label": "Más de 3.5",
      "kind": "binary",
      "weights": {
        "poisson": 1.0,
        "logit_xg_elo": 0.0,
        "logit_core": 5.2909066017292616e-17,
        "logit_xg_shots": 0.0
      },
      "weight_loss": 0.630957386693854,
      "models": {
        "poisson": {
          "n": 1504,
          "hits": 1063,
          "accuracy": 0.706781914893617,
          "logLoss": 0.5987585306232068,
          "brier": 0.20479610069274676,
          "ece": 0.050328060833491756
        },
        "logit_xg_elo": {
          "n": 1504,
          "hits": 1079,
          "accuracy": 0.7174202127659575,
          "logLoss": 0.5946869997964781,
          "brier": 0.20247776615354762,
          "ece": 0.03649387381746347
        },
        "logit_core": {
          "n": 1504,
          "hits": 1076,
          "accuracy": 0.7154255319148937,
          "logLoss": 0.6018720765938849,
          "brier": 0.20571207369061534,
          "ece": 0.061456275559266305
        },
        "logit_xg_shots": {
          "n": 1504,
          "hits": 1079,
          "accuracy": 0.7174202127659575,
          "logLoss": 0.5956641937767663,
          "brier": 0.20290239883870118,
          "ece": 0.03886288568777891
        }
      },
      "temperatures": {
        "poisson": 1.2278916558980006,
        "logit_xg_elo": 1.2848490541380109,
        "logit_core": 1.4856704345304312,
        "logit_xg_shots": 1.3049273318834562
      },
      "fallbacks": 0
    }
  },
  "models": [
    {
      "id": "poisson",
      "label": "Poisson + Dixon-Coles",
      "family": "poisson",
      "features": [],
      "metrics": {
        "1x2": {
          "n": 1504,
          "hits": 758,
          "accuracy": 0.5039893617021277,
          "logLoss": 1.0094160880700793,
          "brier": 0.6043316923178546,
          "ece": 0.02214217252047965
        },
        "btts": {
          "n": 1504,
          "hits": 826,
          "accuracy": 0.5492021276595744,
          "logLoss": 0.6887113191710885,
          "brier": 0.2477622925909434,
          "ece": 0.048632849971278314
        },
        "over15": {
          "n": 1504,
          "hits": 1165,
          "accuracy": 0.7746010638297872,
          "logLoss": 0.5296034689069921,
          "brier": 0.17317959357453763,
          "ece": 0.040276469994524444
        },
        "over25": {
          "n": 1504,
          "hits": 829,
          "accuracy": 0.5511968085106383,
          "logLoss": 0.687371502578751,
          "brier": 0.24714779860445213,
          "ece": 0.018860104736781565
        },
        "over35": {
          "n": 1504,
          "hits": 1063,
          "accuracy": 0.706781914893617,
          "logLoss": 0.5987585306232068,
          "brier": 0.20479610069274676,
          "ece": 0.050328060833491756
        }
      },
      "temperatures": {
        "1x2": 0.7907848927448622,
        "btts": 1.3379268762734156,
        "over15": 0.9896614982408373,
        "over25": 1.6680456691329282,
        "over35": 1.2278916558980006
      },
      "weights": {
        "1x2": 3.262093286465761e-17,
        "btts": 0.9999999999999998,
        "over15": 0.6391748439967436,
        "over25": 1.0,
        "over35": 1.0
      }
    },
    {
      "id": "logit_xg_elo",
      "label": "Logística Elo + xG",
      "family": "logistic",
      "features": [
        "elo_diff",
        "xg_diff_5",
        "xg_diff_20",
        "d_xg_for_10",
        "d_xg_against_10",
        "is_esp"
      ],
      "metrics": {
        "1x2": {
          "n": 1504,
          "hits": 801,
          "accuracy": 0.5325797872340425,
          "logLoss": 0.9899369418628066,
          "brier": 0.5889051131077614,
          "ece": 0.03578547160203265
        },
        "btts": {
          "n": 1504,
          "hits": 766,
          "accuracy": 0.5093085106382979,
          "logLoss": 0.6933928642115276,
          "brier": 0.25012286127026595,
          "ece": 0.05361422092967918
        },
        "over15": {
          "n": 1504,
          "hits": 1170,
          "accuracy": 0.7779255319148937,
          "logLoss": 0.5259929124687558,
          "brier": 0.17155974444376024,
          "ece": 0.009979190039380754
        },
        "over25": {
          "n": 1504,
          "hits": 798,
          "accuracy": 0.5305851063829787,
          "logLoss": 0.6919038929952287,
          "brier": 0.24933526306526838,
          "ece": 0.042532286747686214
        },
        "over35": {
          "n": 1504,
          "hits": 1079,
          "accuracy": 0.7174202127659575,
          "logLoss": 0.5946869997964781,
          "brier": 0.20247776615354762,
          "ece": 0.03649387381746347
        }
      },
      "temperatures": {
        "1x2": 0.9297103139427606,
        "btts": 0.5000004897189497,
        "over15": 0.7647144028501809,
        "over25": 0.6748336734122008,
        "over35": 1.2848490541380109
      },
      "weights": {
        "1x2": 0.0,
        "btts": 2.810252031082427e-16,
        "over15": 0.0,
        "over25": 4.163336342344337e-17,
        "over35": 0.0
      }
    },
    {
      "id": "logit_core",
      "label": "Logística core",
      "family": "logistic",
      "features": [
        "elo_diff",
        "xg_diff_5",
        "xg_diff_20",
        "d_xg_for_10",
        "d_xg_against_10",
        "d_shots_for_10",
        "d_shots_against_10",
        "d_ppda_10",
        "rest_diff",
        "travel_diff",
        "position_diff",
        "d_ppg",
        "league_goals_avg_prior",
        "match_importance",
        "is_derby",
        "season_progress",
        "is_esp"
      ],
      "metrics": {
        "1x2": {
          "n": 1504,
          "hits": 788,
          "accuracy": 0.523936170212766,
          "logLoss": 0.9946736055924585,
          "brier": 0.5920310874018208,
          "ece": 0.030118047560379765
        },
        "btts": {
          "n": 1504,
          "hits": 794,
          "accuracy": 0.5279255319148937,
          "logLoss": 0.692704992427598,
          "brier": 0.24977858307516285,
          "ece": 0.0612310870485757
        },
        "over15": {
          "n": 1504,
          "hits": 1169,
          "accuracy": 0.7772606382978723,
          "logLoss": 0.5375590003026978,
          "brier": 0.17377284704228374,
          "ece": 0.011224594135156666
        },
        "over25": {
          "n": 1504,
          "hits": 787,
          "accuracy": 0.5232712765957447,
          "logLoss": 0.6978641766866469,
          "brier": 0.25129273533135293,
          "ece": 0.03436831609134532
        },
        "over35": {
          "n": 1504,
          "hits": 1076,
          "accuracy": 0.7154255319148937,
          "logLoss": 0.6018720765938849,
          "brier": 0.20571207369061534,
          "ece": 0.061456275559266305
        }
      },
      "temperatures": {
        "1x2": 0.9207773169265023,
        "btts": 2.999999324844608,
        "over15": 0.8036079703330822,
        "over25": 2.9999995569962326,
        "over35": 1.4856704345304312
      },
      "weights": {
        "1x2": 0.42679177738048457,
        "btts": 0.0,
        "over15": 0.3608251560032565,
        "over25": 1.138463400473807e-17,
        "over35": 5.2909066017292616e-17
      }
    },
    {
      "id": "logit_xg_shots",
      "label": "Logística Elo + xG + tiros",
      "family": "logistic",
      "features": [
        "elo_diff",
        "xg_diff_5",
        "xg_diff_20",
        "d_xg_for_10",
        "d_xg_against_10",
        "d_shots_for_10",
        "d_shots_against_10",
        "d_sot_for_10",
        "d_sot_against_10",
        "is_esp"
      ],
      "metrics": {
        "1x2": {
          "n": 1504,
          "hits": 799,
          "accuracy": 0.53125,
          "logLoss": 0.9880191251975448,
          "brier": 0.5877359003086773,
          "ece": 0.040190066592154544
        },
        "btts": {
          "n": 1504,
          "hits": 791,
          "accuracy": 0.5259308510638298,
          "logLoss": 0.6927283264443217,
          "brier": 0.24979071995189325,
          "ece": 0.05828216678312962
        },
        "over15": {
          "n": 1504,
          "hits": 1170,
          "accuracy": 0.7779255319148937,
          "logLoss": 0.5271422604376125,
          "brier": 0.1720687582756276,
          "ece": 0.013270016348803277
        },
        "over25": {
          "n": 1504,
          "hits": 797,
          "accuracy": 0.5299202127659575,
          "logLoss": 0.6905809179455301,
          "brier": 0.24871447252981377,
          "ece": 0.0371295527353041
        },
        "over35": {
          "n": 1504,
          "hits": 1079,
          "accuracy": 0.7174202127659575,
          "logLoss": 0.5956641937767663,
          "brier": 0.20290239883870118,
          "ece": 0.03886288568777891
        }
      },
      "temperatures": {
        "1x2": 0.918451443646904,
        "btts": 0.9849702934025492,
        "over15": 0.7686818299071848,
        "over25": 1.0802747783432414,
        "over35": 1.3049273318834562
      },
      "weights": {
        "1x2": 0.5732082226195153,
        "btts": 0.0,
        "over15": 0.0,
        "over25": 0.0,
        "over35": 0.0
      }
    }
  ],
  "ensemble": {
    "members": [
      "poisson",
      "logit_xg_elo",
      "logit_core",
      "logit_xg_shots"
    ],
    "weightFloor": 0.0,
    "weights": {
      "1x2": {
        "poisson": 3.262093286465761e-17,
        "logit_xg_elo": 0.0,
        "logit_core": 0.42679177738048457,
        "logit_xg_shots": 0.5732082226195153
      },
      "btts": {
        "poisson": 0.9999999999999998,
        "logit_xg_elo": 2.810252031082427e-16,
        "logit_core": 0.0,
        "logit_xg_shots": 0.0
      },
      "over15": {
        "poisson": 0.6391748439967436,
        "logit_xg_elo": 0.0,
        "logit_core": 0.3608251560032565,
        "logit_xg_shots": 0.0
      },
      "over25": {
        "poisson": 1.0,
        "logit_xg_elo": 4.163336342344337e-17,
        "logit_core": 1.138463400473807e-17,
        "logit_xg_shots": 0.0
      },
      "over35": {
        "poisson": 1.0,
        "logit_xg_elo": 0.0,
        "logit_core": 5.2909066017292616e-17,
        "logit_xg_shots": 0.0
      }
    },
    "calibration": "temperature scaling por modelo y mercado",
    "fallback": {
      "policy": "Si el partido no tiene fila en el feature store o falta el ancla Elo (elo_diff), el ensamble usa Poisson calibrado. Las features auxiliares ausentes se imputan con la mediana de entrenamiento y se añade un indicador de ausencia.",
      "anchor": "elo_diff",
      "test_fallbacks": {
        "1x2": 0,
        "btts": 0,
        "over15": 0,
        "over25": 0,
        "over35": 0
      },
      "imputed_features": {
        "xg_elo": [
          "elo_diff",
          "xg_diff_5",
          "xg_diff_20",
          "d_xg_for_10",
          "d_xg_against_10"
        ],
        "core": [
          "elo_diff",
          "xg_diff_5",
          "xg_diff_20",
          "d_xg_for_10",
          "d_xg_against_10",
          "d_shots_for_10",
          "d_shots_against_10",
          "d_ppda_10",
          "rest_diff",
          "position_diff",
          "d_ppg",
          "league_goals_avg_prior",
          "match_importance"
        ],
        "lean": [
          "elo_diff",
          "xg_diff_5",
          "xg_diff_20",
          "d_xg_for_10",
          "d_xg_against_10",
          "d_shots_for_10",
          "d_shots_against_10",
          "d_sot_for_10",
          "d_sot_against_10"
        ]
      },
      "note": "El fallback evita que una predicción falle por falta de una feature. No se presenta una estimación como observada: cada feature del reporte lleva quality, source y as_of."
    }
  },
  "benchmark": {
    "available": true,
    "source": "Football-Data.co.uk · cuotas de cierre Bet365 y Pinnacle",
    "closing": true,
    "excluded_as_feature": true,
    "note": "Solo referencia externa. El mercado de cierre no se usa como feature por la decisión de la Sección 2 y no forma parte del ensamble.",
    "markets": {
      "1x2": {
        "n": 1504,
        "hits": 802,
        "accuracy": 0.5332446808510638,
        "logLoss": 0.9765567839196835,
        "brier": 0.581286980635752,
        "ece": 0.03155319482603913,
        "coverage": 1.0,
        "bookmakers": [
          "Bet365",
          "Pinnacle"
        ]
      },
      "over25": {
        "n": 1504,
        "hits": 851,
        "accuracy": 0.5658244680851063,
        "logLoss": 0.676827707806732,
        "brier": 0.24199318518908275,
        "ece": 0.022598868645414813,
        "coverage": 1.0,
        "bookmakers": [
          "Bet365",
          "Pinnacle"
        ]
      }
    }
  },
  "byLeague": [
    {
      "id": "eng.1",
      "name": "Premier League",
      "n": 752,
      "hits": 392,
      "accuracy": 0.5212765957446809,
      "logLoss": 1.007432444067979,
      "brier": 0.6040327145111445,
      "skill": 0.06783943063162923
    },
    {
      "id": "esp.1",
      "name": "LaLiga",
      "n": 752,
      "hits": 410,
      "accuracy": 0.5452127659574468,
      "logLoss": 0.970763441227535,
      "brier": 0.5730784318858939,
      "skill": 0.11560896533256915
    }
  ],
  "bySeason": [
    {
      "season": "2024-25",
      "n": 752,
      "hits": 420,
      "accuracy": 0.5585106382978723,
      "logLoss": 0.9743344030911475,
      "brier": 0.5782972457090652,
      "skill": 0.1075551425048239
    },
    {
      "season": "2025-26",
      "n": 752,
      "hits": 382,
      "accuracy": 0.5079787234042553,
      "logLoss": 1.0038614822043659,
      "brier": 0.5988139006879734,
      "skill": 0.07589325345937448
    }
  ],
  "timeline": [
    {
      "month": "2024-08",
      "n": 54,
      "hits": 33,
      "accuracy": 0.6111111111111112,
      "logLoss": 0.9105581790272596,
      "brier": 0.5422508659924158,
      "skill": 0.1631829471470514
    },
    {
      "month": "2024-09",
      "n": 78,
      "hits": 49,
      "accuracy": 0.6282051282051282,
      "logLoss": 0.9179093628807359,
      "brier": 0.5363342742606609,
      "skill": 0.172313600810167
    },
    {
      "month": "2024-10",
      "n": 60,
      "hits": 30,
      "accuracy": 0.5,
      "logLoss": 0.9944891052023076,
      "brier": 0.5914001851857678,
      "skill": 0.08733431136509417
    },
    {
      "month": "2024-11",
      "n": 68,
      "hits": 31,
      "accuracy": 0.45588235294117646,
      "logLoss": 1.076411948366987,
      "brier": 0.6331262342248845,
      "skill": 0.02294147850127426
    },
    {
      "month": "2024-12",
      "n": 101,
      "hits": 51,
      "accuracy": 0.504950495049505,
      "logLoss": 1.0462435545880033,
      "brier": 0.6281607874906533,
      "skill": 0.030604297987293694
    },
    {
      "month": "2025-01",
      "n": 71,
      "hits": 36,
      "accuracy": 0.5070422535211268,
      "logLoss": 0.9934385431071853,
      "brier": 0.5973458361231045,
      "skill": 0.0781588127043984
    },
    {
      "month": "2025-02",
      "n": 82,
      "hits": 50,
      "accuracy": 0.6097560975609756,
      "logLoss": 0.9428284099073411,
      "brier": 0.5554475852359027,
      "skill": 0.14281739238772173
    },
    {
      "month": "2025-03",
      "n": 56,
      "hits": 30,
      "accuracy": 0.5357142857142857,
      "logLoss": 0.9509437206292762,
      "brier": 0.5698751853973169,
      "skill": 0.12055230697431418
    },
    {
      "month": "2025-04",
      "n": 91,
      "hits": 52,
      "accuracy": 0.5714285714285714,
      "logLoss": 0.9677705725037065,
      "brier": 0.5744682327038532,
      "skill": 0.11346418494128518
    },
    {
      "month": "2025-05",
      "n": 91,
      "hits": 58,
      "accuracy": 0.6373626373626373,
      "logLoss": 0.9256088429868444,
      "brier": 0.5454417376913843,
      "skill": 0.15825870263473374
    },
    {
      "month": "2025-08",
      "n": 55,
      "hits": 27,
      "accuracy": 0.4909090909090909,
      "logLoss": 0.9984405261928997,
      "brier": 0.597434180971671,
      "skill": 0.07802247640611171
    },
    {
      "month": "2025-09",
      "n": 67,
      "hits": 32,
      "accuracy": 0.47761194029850745,
      "logLoss": 0.9809755930966597,
      "brier": 0.584426980590102,
      "skill": 0.09809556023466681
    },
    {
      "month": "2025-10",
      "n": 61,
      "hits": 35,
      "accuracy": 0.5737704918032787,
      "logLoss": 0.9930187446027191,
      "brier": 0.5832200601638748,
      "skill": 0.09995811437232593
    },
    {
      "month": "2025-11",
      "n": 78,
      "hits": 49,
      "accuracy": 0.6282051282051282,
      "logLoss": 0.8781568520165226,
      "brier": 0.5179838721100014,
      "skill": 0.20063246650395838
    },
    {
      "month": "2025-12",
      "n": 88,
      "hits": 50,
      "accuracy": 0.5681818181818182,
      "logLoss": 0.972413651883758,
      "brier": 0.5750161254041125,
      "skill": 0.11261866124835107
    },
    {
      "month": "2026-01",
      "n": 92,
      "hits": 39,
      "accuracy": 0.42391304347826086,
      "logLoss": 1.086891586239326,
      "brier": 0.6660616832628812,
      "skill": -0.027885448898691267
    },
    {
      "month": "2026-02",
      "n": 82,
      "hits": 40,
      "accuracy": 0.4878048780487805,
      "logLoss": 1.0071886000230361,
      "brier": 0.6005162178821544,
      "skill": 0.07326618885368064
    },
    {
      "month": "2026-03",
      "n": 68,
      "hits": 32,
      "accuracy": 0.47058823529411764,
      "logLoss": 1.0658639297766592,
      "brier": 0.6376627837481842,
      "skill": 0.015940545464014244
    },
    {
      "month": "2026-04",
      "n": 70,
      "hits": 35,
      "accuracy": 0.5,
      "logLoss": 1.0001807140950278,
      "brier": 0.5950928555555903,
      "skill": 0.08163567678499639
    },
    {
      "month": "2026-05",
      "n": 91,
      "hits": 43,
      "accuracy": 0.4725274725274725,
      "logLoss": 1.0389733334989057,
      "brier": 0.6173011760873547,
      "skill": 0.04736316105154137
    }
  ],
  "calibration": {
    "1x2": [
      {
        "from": 0.30000000000000004,
        "to": 0.4,
        "n": 178,
        "predicted": 0.3777605601945488,
        "observed": 0.4101123595505618
      },
      {
        "from": 0.4,
        "to": 0.5,
        "n": 457,
        "predicted": 0.4480166777476859,
        "observed": 0.45951859956236324
      },
      {
        "from": 0.5,
        "to": 0.6000000000000001,
        "n": 363,
        "predicted": 0.5491244204081795,
        "observed": 0.4931129476584022
      },
      {
        "from": 0.6000000000000001,
        "to": 0.7000000000000001,
        "n": 283,
        "predicted": 0.6484180598412533,
        "observed": 0.6183745583038869
      },
      {
        "from": 0.7000000000000001,
        "to": 0.8,
        "n": 149,
        "predicted": 0.745790185113673,
        "observed": 0.6711409395973155
      },
      {
        "from": 0.8,
        "to": 0.9,
        "n": 71,
        "predicted": 0.8299673223572503,
        "observed": 0.8732394366197183
      },
      {
        "from": 0.9,
        "to": 1.0,
        "n": 3,
        "predicted": 0.9132974686614593,
        "observed": 1.0
      }
    ],
    "btts": [
      {
        "from": 0.30000000000000004,
        "to": 0.4,
        "n": 30,
        "predicted": 0.3757579557792601,
        "observed": 0.5666666666666667
      },
      {
        "from": 0.4,
        "to": 0.5,
        "n": 497,
        "predicted": 0.46516540830958925,
        "observed": 0.5171026156941649
      },
      {
        "from": 0.5,
        "to": 0.6000000000000001,
        "n": 868,
        "predicted": 0.5432423739680483,
        "observed": 0.586405529953917
      },
      {
        "from": 0.6000000000000001,
        "to": 0.7000000000000001,
        "n": 109,
        "predicted": 0.625120491415708,
        "observed": 0.5871559633027523
      }
    ],
    "over25": [
      {
        "from": 0.2,
        "to": 0.30000000000000004,
        "n": 1,
        "predicted": 0.2952882580381716,
        "observed": 1.0
      },
      {
        "from": 0.30000000000000004,
        "to": 0.4,
        "n": 70,
        "predicted": 0.3719806417178612,
        "observed": 0.4
      },
      {
        "from": 0.4,
        "to": 0.5,
        "n": 596,
        "predicted": 0.46187078899371914,
        "observed": 0.4815436241610738
      },
      {
        "from": 0.5,
        "to": 0.6000000000000001,
        "n": 727,
        "predicted": 0.5424209561115185,
        "observed": 0.5557083906464925
      },
      {
        "from": 0.6000000000000001,
        "to": 0.7000000000000001,
        "n": 106,
        "predicted": 0.6304062344019219,
        "observed": 0.660377358490566
      },
      {
        "from": 0.7000000000000001,
        "to": 0.8,
        "n": 4,
        "predicted": 0.7155957794144479,
        "observed": 1.0
      }
    ]
  },
  "fallback": {
    "policy": "Si el partido no tiene fila en el feature store o falta el ancla Elo (elo_diff), el ensamble usa Poisson calibrado. Las features auxiliares ausentes se imputan con la mediana de entrenamiento y se añade un indicador de ausencia.",
    "anchor": "elo_diff",
    "test_fallbacks": {
      "1x2": 0,
      "btts": 0,
      "over15": 0,
      "over25": 0,
      "over35": 0
    },
    "imputed_features": {
      "xg_elo": [
        "elo_diff",
        "xg_diff_5",
        "xg_diff_20",
        "d_xg_for_10",
        "d_xg_against_10"
      ],
      "core": [
        "elo_diff",
        "xg_diff_5",
        "xg_diff_20",
        "d_xg_for_10",
        "d_xg_against_10",
        "d_shots_for_10",
        "d_shots_against_10",
        "d_ppda_10",
        "rest_diff",
        "position_diff",
        "d_ppg",
        "league_goals_avg_prior",
        "match_importance"
      ],
      "lean": [
        "elo_diff",
        "xg_diff_5",
        "xg_diff_20",
        "d_xg_for_10",
        "d_xg_against_10",
        "d_shots_for_10",
        "d_shots_against_10",
        "d_sot_for_10",
        "d_sot_against_10"
      ]
    },
    "note": "El fallback evita que una predicción falle por falta de una feature. No se presenta una estimación como observada: cada feature del reporte lleva quality, source y as_of."
  },
  "notes": [
    "Split temporal estricto: 2020-21 a 2022-23 para entrenar, 2023-24 para calibrar y pesar, 2024-25 y 2025-26 para test.",
    "Cada modelo se calibra con temperature scaling antes de compararse.",
    "Los pesos del ensamble se aprenden solo en la segunda mitad de la validación, sin piso artificial; los modelos que no aportan reciben peso cero.",
    "El ensamble 1X2 combina la logística Elo + xG + tiros con la logística core; los mercados binarios siguen dominados por Poisson.",
    "El test no participa en el entrenamiento, la calibración ni la elección de pesos.",
    "El benchmark de cuotas de cierre es solo una referencia externa; no es una feature ni forma parte del ensamble.",
    "La muestra se limita a los partidos con baseline Poisson comparable (equipos con al menos 4 partidos previos)."
  ],
  "limitations": [
    "Dos ligas y seis temporadas: la muestra es suficiente para un piloto, no para prometer precisión universal.",
    "El modelo no usa alineaciones confirmadas, lesiones, sanciones, árbitro ni clima en vivo.",
    "El mercado de cierre se reporta como referencia, no como señal del modelo.",
    "Una tasa de aciertos histórica no garantiza resultados futuros y no es una recomendación.",
    "Los modelos tabulares pueden degradarse si cambia la distribución de features entre temporadas."
  ]
};
