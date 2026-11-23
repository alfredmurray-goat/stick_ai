#include "kv_cache.hpp"
#include <chrono>
#include <iostream>
#include <vector>
#include <string>
int main(int argc,char**argv) {
 if (argc > 2 || (argc == 2 && std::string(argv[1]) != "q8" && std::string(argv[1]) != "f16")) {
  std::cerr << "Usage: stellan-cache-bench [f16|q8]\n"; return 2;
 }
 const bool q8=argc>1 && std::string(argv[1])=="q8";
 stellan::KVCache cache(65536,1024,q8);
 std::vector<float> input(1024);
 for(std::size_t i=0;i<input.size();++i) input[i]=float(int(i%31)-15)/16;
 const auto begin=std::chrono::steady_clock::now();
 for(std::size_t t=0;t<65536;++t) cache.write(t,input);
 const auto end=std::chrono::steady_clock::now();
 double checksum=0;
 for(std::size_t t=0;t<65536;++t) checksum+=cache.read(t,t%1024);
 const auto usage = stellan::usage();
 std::cout<<"{\"write_ms\":"<<std::chrono::duration<double,std::milli>(end-begin).count()<<",\"peak_rss_bytes\":"<<usage.peak_rss_bytes<<",\"cache_bytes\":"<<cache.bytes()<<",\"checksum\":"<<checksum<<"}\n";
}
