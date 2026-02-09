/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/clawscrow.json`.
 */
export type Clawscrow = {
  "address": "7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7",
  "metadata": {
    "name": "clawscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Trustless USDC escrow with AI arbitration for agent-to-agent commerce on Solana"
  },
  "instructions": [
    {
      "name": "acceptEscrow",
      "discriminator": [
        193,
        2,
        224,
        245,
        36,
        116,
        65,
        154
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "sellerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "approve",
      "discriminator": [
        69,
        74,
        217,
        36,
        115,
        117,
        97,
        76
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "sellerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "arbitrate",
      "discriminator": [
        105,
        91,
        110,
        150,
        216,
        11,
        142,
        142
      ],
      "accounts": [
        {
          "name": "arbitrator",
          "writable": true,
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "sellerToken",
          "writable": true
        },
        {
          "name": "arbitratorToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
        },
        {
          "name": "ruling",
          "type": {
            "defined": {
              "name": "ruling"
            }
          }
        }
      ]
    },
    {
      "name": "autoApprove",
      "discriminator": [
        36,
        58,
        85,
        199,
        138,
        197,
        222,
        178
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "sellerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createEscrow",
      "discriminator": [
        253,
        215,
        165,
        116,
        36,
        108,
        68,
        80
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "arbitrator"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "paymentAmount",
          "type": "u64"
        },
        {
          "name": "buyerCollateral",
          "type": "u64"
        },
        {
          "name": "sellerCollateral",
          "type": "u64"
        },
        {
          "name": "deadlineTs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "deliver",
      "discriminator": [
        250,
        131,
        222,
        57,
        211,
        229,
        209,
        147
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "deliveryHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "raiseDispute",
      "discriminator": [
        41,
        243,
        1,
        51,
        150,
        95,
        246,
        73
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "escrow",
      "discriminator": [
        31,
        213,
        123,
        187,
        186,
        22,
        218,
        155
      ]
    }
  ],
  "events": [
    {
      "name": "disputeResolved",
      "discriminator": [
        121,
        64,
        249,
        153,
        139,
        128,
        236,
        187
      ]
    },
    {
      "name": "escrowAccepted",
      "discriminator": [
        129,
        122,
        76,
        235,
        127,
        11,
        32,
        165
      ]
    },
    {
      "name": "escrowApproved",
      "discriminator": [
        87,
        181,
        230,
        68,
        208,
        43,
        121,
        31
      ]
    },
    {
      "name": "escrowCreated",
      "discriminator": [
        70,
        127,
        105,
        102,
        92,
        97,
        7,
        173
      ]
    },
    {
      "name": "escrowDisputed",
      "discriminator": [
        132,
        73,
        81,
        200,
        177,
        51,
        128,
        18
      ]
    },
    {
      "name": "workDelivered",
      "discriminator": [
        253,
        153,
        93,
        38,
        72,
        231,
        61,
        157
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidState",
      "msg": "Invalid escrow state for this operation"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6002,
      "name": "invalidAmount",
      "msg": "Invalid amount"
    },
    {
      "code": 6003,
      "name": "descriptionTooLong",
      "msg": "Description too long"
    },
    {
      "code": 6004,
      "name": "invalidDeadline",
      "msg": "Invalid deadline"
    },
    {
      "code": 6005,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6006,
      "name": "reviewPeriodActive",
      "msg": "Review period still active"
    }
  ],
  "types": [
    {
      "name": "disputeResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "ruling",
            "type": {
              "defined": {
                "name": "ruling"
              }
            }
          }
        ]
      }
    },
    {
      "name": "escrow",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "arbitrator",
            "type": "pubkey"
          },
          {
            "name": "paymentAmount",
            "type": "u64"
          },
          {
            "name": "buyerCollateral",
            "type": "u64"
          },
          {
            "name": "sellerCollateral",
            "type": "u64"
          },
          {
            "name": "deadlineTs",
            "type": "i64"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "escrowState"
              }
            }
          },
          {
            "name": "deliveryHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "deliveredAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "escrowAccepted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "seller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "escrowApproved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "escrowCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "paymentAmount",
            "type": "u64"
          },
          {
            "name": "buyerCollateral",
            "type": "u64"
          },
          {
            "name": "sellerCollateral",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "escrowDisputed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "escrowState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "created"
          },
          {
            "name": "accepted"
          },
          {
            "name": "delivered"
          },
          {
            "name": "approved"
          },
          {
            "name": "disputed"
          },
          {
            "name": "resolvedBuyer"
          },
          {
            "name": "resolvedSeller"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "ruling",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "buyerWins"
          },
          {
            "name": "sellerWins"
          }
        ]
      }
    },
    {
      "name": "workDelivered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "deliveryHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    }
  ]
};
