set(Proj_Name UMSC-CPP)

file(GLOB ALL_FILES "headers/*.h" "sources/*.cpp")

add_library(${Proj_Name} ${ALL_FILES})

target_compile_options(${Proj_Name} PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/utf-8>
)

target_include_directories(${Proj_Name} PUBLIC 
    ./headers 
)

# set_target_properties(${Proj_Name} PROPERTIES
#     CXX_VISIBILITY_PRESET hidden
#     VISIBILITY_INLINES_HIDDEN YES
# )

target_link_libraries(${Proj_Name} PUBLIC 

)



