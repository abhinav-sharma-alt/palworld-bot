#!/bin/bash
# Usage: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... [DISCORD_GUILD_ID=...] ./register-commands.sh
# With DISCORD_GUILD_ID the commands appear instantly in that server; without it they're global (can take a while).
set -e
if [ -n "$DISCORD_GUILD_ID" ]; then
  URL="https://discord.com/api/v10/applications/$DISCORD_APP_ID/guilds/$DISCORD_GUILD_ID/commands"
else
  URL="https://discord.com/api/v10/applications/$DISCORD_APP_ID/commands"
fi
curl -sS -X PUT "$URL" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '[
  {"name":"start","description":"Start the Palworld server","options":[{"type":3,"name":"world","description":"World name (default: default)","required":false}]},
  {"name":"stop","description":"Save and stop the Palworld server"},
  {"name":"console","description":"Run a Palworld admin command","options":[{"type":3,"name":"command","description":"save | info | players | metrics | announce <msg> | kick <id> | ban <id> | unban <id>","required":true}]},
  {"name":"world","description":"Manage Palworld worlds","options":[
    {"type":1,"name":"create","description":"Create a new world config","options":[
      {"type":3,"name":"name","description":"World name, lowercase (e.g. default, friends)","required":true},
      {"type":3,"name":"tunnel_address","description":"Your playit.gg UDP tunnel address","required":false},
      {"type":3,"name":"server_name","description":"Name shown in the server list","required":false},
      {"type":4,"name":"max_players","description":"Max players (1-32, default 16)","required":false,"min_value":1,"max_value":32},
      {"type":4,"name":"server_port","description":"Local UDP port (default 8211)","required":false,"min_value":1024,"max_value":65535},
      {"type":3,"name":"settings","description":"Overrides, e.g. ExpRate=2,DeathPenalty=None,bIsPvP=false","required":false}]},
    {"type":1,"name":"configure","description":"Change an existing world config","options":[
      {"type":3,"name":"name","description":"World name","required":true},
      {"type":3,"name":"tunnel_address","description":"Your playit.gg UDP tunnel address","required":false},
      {"type":3,"name":"server_name","description":"Name shown in the server list","required":false},
      {"type":4,"name":"max_players","description":"Max players (1-32)","required":false,"min_value":1,"max_value":32},
      {"type":4,"name":"server_port","description":"Local UDP port","required":false,"min_value":1024,"max_value":65535},
      {"type":3,"name":"settings","description":"Overrides to merge; Key= (empty) removes one","required":false}]},
    {"type":1,"name":"list","description":"List worlds"}]},
  {"name":"access","description":"Manage who can use /console","options":[
    {"type":1,"name":"list","description":"List users with access"},
    {"type":1,"name":"add","description":"Grant console access","options":[{"type":6,"name":"user","description":"User","required":true}]},
    {"type":1,"name":"remove","description":"Revoke console access","options":[{"type":6,"name":"user","description":"User","required":true}]}]}
]'