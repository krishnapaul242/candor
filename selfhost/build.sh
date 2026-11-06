#!/bin/sh
# Concatenate the compiler's sections (Candor has no modules yet) into one file.
cd "$(dirname "$0")" || exit 1
cat 00_util.cnd 10_lexer.cnd 20_parser.cnd 30_check.cnd 40_cgen.cnd 50_main.cnd > candorc.cnd
